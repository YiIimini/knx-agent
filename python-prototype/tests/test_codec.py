"""Wire-level tests. Byte vectors are the ones python-xknx uses against real
devices (A_Memory_Read / A_Memory_Write), so a regression here means the codec
no longer produces telegrams a real device understands."""

import unittest

from knxagent import cemi


class TestAddresses(unittest.TestCase):
    def test_individual_address(self):
        self.assertEqual(cemi.parse_ia("1.1.5"), 0x1105)
        self.assertEqual(cemi.format_ia(0x1105), "1.1.5")
        self.assertEqual(cemi.format_ia(cemi.parse_ia("15.15.255")), "15.15.255")

    def test_group_address(self):
        self.assertEqual(cemi.parse_ga("1/2/3"), (1 << 11) | (2 << 8) | 3)
        self.assertEqual(cemi.format_ga(cemi.parse_ga("1/2/3")), "1/2/3")
        self.assertEqual(cemi.parse_ga("0/0"), 0)
        self.assertEqual(cemi.format_ga(cemi.parse_ga("31/7/255")), "31/7/255")


class TestApduVectors(unittest.TestCase):
    def test_memory_read_vector(self):
        # A_Memory_Read, address 0x1234, 11 octets
        self.assertEqual(cemi.apdu_memory_read(0x1234, 11), bytes.fromhex("020b1234"))

    def test_memory_write_vector(self):
        # A_Memory_Write, address 0x1234, 3 octets AA BB CC
        self.assertEqual(cemi.apdu_memory_write(0x1234, bytes.fromhex("aabbcc")),
                         bytes.fromhex("02831234aabbcc"))

    def test_memory_response_roundtrip(self):
        apdu = cemi.apdu_memory_response(0x4000, bytes.fromhex("0102"))
        frame = cemi.parse(cemi.ldata(0x1105, apdu, group=False))
        self.assertEqual(frame["service"], "A_Memory_Response")
        self.assertEqual(frame["address"], 0x4000)
        self.assertEqual(frame["value"], bytes.fromhex("0102"))

    def test_group_write_small_form(self):
        self.assertEqual(cemi.apdu_group_write(b"\x01"), bytes.fromhex("0081"))
        self.assertEqual(cemi.apdu_group_read(), bytes.fromhex("0000"))

    def test_group_read_parses(self):
        frame = cemi.parse(cemi.ldata(cemi.parse_ga("1/2/3"), cemi.apdu_group_read(), group=True))
        self.assertEqual(frame["service"], "A_GroupValue_Read")
        self.assertEqual(frame["dst_text"], "1/2/3")
        self.assertTrue(frame["group"])

    def test_memory_write_limits(self):
        with self.assertRaises(ValueError):
            cemi.apdu_memory_read(0x1234, 16)
        with self.assertRaises(ValueError):
            cemi.apdu_memory_read(0x1_0000, 1)


class TestLDataFraming(unittest.TestCase):
    def test_control_octets_match_ets(self):
        # a standard group frame as ETS emits it: 0xBC / 0xE0
        frame = cemi.ldata(cemi.parse_ga("1/2/3"), cemi.apdu_group_write(b"\x01"), group=True)
        self.assertEqual(frame[0], cemi.L_DATA_REQ)
        self.assertEqual(frame[1], 0x00)
        self.assertEqual(frame[2], 0xBC)
        self.assertEqual(frame[3], 0xE0)
        self.assertEqual(frame[8], 2)  # NPDU length

    def test_individual_frame_control_octets(self):
        frame = cemi.ldata(0x1105, cemi.apdu_descriptor_read(), group=False)
        self.assertEqual(frame[2], 0xBC)
        self.assertEqual(frame[3], 0x60)

    def test_extended_frame_threshold(self):
        # 12 data octets -> 15 octet APDU -> still L_Data_Standard
        short = cemi.ldata(0x1105, cemi.apdu_memory_write(0x4000, b"\x00" * 11), group=False)
        self.assertTrue(short[2] & 0x80, "15 octet APDU must stay a standard frame")
        # 12 data octets -> 16 octet APDU -> L_Data_Extended
        long_ = cemi.ldata(0x1105, cemi.apdu_memory_write(0x4000, b"\x00" * 12), group=False)
        self.assertFalse(long_[2] & 0x80, "16 octet APDU needs an extended frame")

    def test_confirmation_mirrors_request(self):
        req = cemi.ldata(0x1105, cemi.apdu_restart(), group=False)
        con = cemi.ldata_confirm(cemi.parse(req))
        self.assertEqual(con[0], cemi.L_DATA_CON)
        self.assertEqual(con[4:9], req[4:9])


if __name__ == "__main__":
    unittest.main()
