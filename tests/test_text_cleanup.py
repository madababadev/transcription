import unittest

from text_cleanup import format_transcript


class TextCleanupTests(unittest.TestCase):
    def test_dialogue_labels_and_numbers_are_preserved(self):
        self.assertEqual(
            format_transcript("moderator: muraho , neza.\nResponder:  uyu munsi 3.14 ni byiza"),
            "Moderator: Muraho, neza.\nResponder: Uyu munsi 3.14 ni byiza.",
        )

    def test_sentence_spacing_and_capitalization(self):
        self.assertEqual(format_transcript("muraho.uyu munsi turaganira"), "Muraho. Uyu munsi turaganira.")


if __name__ == "__main__":
    unittest.main()
