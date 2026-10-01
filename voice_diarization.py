"""Local ONNX voice activity and speaker embeddings for two-person recordings."""

import hashlib
import os
from pathlib import Path
from urllib.request import urlopen

import numpy as np
import onnxruntime as ort
from huggingface_hub import hf_hub_download


SAMPLE_RATE = 16_000
VAD_FRAME = 512
VAD_HASH = "1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3"
VAD_URL = "https://raw.githubusercontent.com/snakers4/silero-vad/v6.2.3/src/silero_vad/data/silero_vad.onnx"
SPEAKER_REPO = "nevil-ramani/pyannote_embedding_onnx"
SPEAKER_FILE = "pyannote_embedding.onnx"
SPEAKER_REVISION = "dcca212b56684d8988003a286447a655ff24f549"
SPEAKER_HASH = "1ac8f94eae62c659e521e9f6dd6f5df250fdbadac990d3e718b67dcf42bb306a"


def _session(path: Path) -> ort.InferenceSession:
    options = ort.SessionOptions()
    options.intra_op_num_threads = max(1, min(4, os.cpu_count() or 1))
    options.inter_op_num_threads = 1
    return ort.InferenceSession(str(path), sess_options=options, providers=["CPUExecutionProvider"])


def _vad_model_path() -> Path:
    configured = os.environ.get("LOCAL_VAD_MODEL_PATH")
    if configured:
        return Path(configured)
    cache = Path(os.environ.get("HF_HOME") or Path(__file__).resolve().parent / ".models") / "speaker"
    path = cache / "silero_vad.onnx"
    if path.exists() and hashlib.sha256(path.read_bytes()).hexdigest() == VAD_HASH:
        return path
    cache.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".download")
    try:
        with urlopen(VAD_URL, timeout=60) as source, temporary.open("wb") as target:
            while chunk := source.read(1024 * 1024):
                target.write(chunk)
        if hashlib.sha256(temporary.read_bytes()).hexdigest() != VAD_HASH:
            raise RuntimeError("The downloaded voice activity model failed its checksum.")
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)
    return path


def _speaker_model_path() -> Path:
    configured = os.environ.get("LOCAL_SPEAKER_MODEL_PATH")
    if configured:
        return Path(configured)
    cache = Path(os.environ.get("HF_HOME") or Path(__file__).resolve().parent / ".models") / "speaker"
    cached = cache / SPEAKER_FILE
    if cached.is_file() and hashlib.sha256(cached.read_bytes()).hexdigest() == SPEAKER_HASH:
        return cached
    downloaded = Path(hf_hub_download(
        repo_id=SPEAKER_REPO,
        filename=SPEAKER_FILE,
        revision=SPEAKER_REVISION,
        local_dir=cache,
        force_download=cached.is_file(),
    ))
    if hashlib.sha256(downloaded.read_bytes()).hexdigest() != SPEAKER_HASH:
        raise RuntimeError("The downloaded speaker model failed its checksum.")
    return downloaded


class VoiceAnalyzer:
    def __init__(self) -> None:
        self.vad = _session(_vad_model_path())
        self.speaker = _session(_speaker_model_path())

    def speech_regions(self, waveform: np.ndarray) -> list[tuple[int, int]]:
        """Find speech intervals with Silero VAD, preserving pauses between turns."""
        if len(waveform) < SAMPLE_RATE // 4:
            return []
        state = np.zeros((2, 1, 128), dtype=np.float32)
        context = np.zeros((1, 64), dtype=np.float32)
        probabilities: list[float] = []
        for start in range(0, len(waveform), VAD_FRAME):
            frame = waveform[start : start + VAD_FRAME]
            if len(frame) < VAD_FRAME:
                frame = np.pad(frame, (0, VAD_FRAME - len(frame)))
            input_audio = np.concatenate((context, frame.reshape(1, -1)), axis=1)
            score, state = self.vad.run(None, {
                "input": input_audio,
                "state": state,
                "sr": np.array(SAMPLE_RATE, dtype=np.int64),
            })
            probabilities.append(float(score[0, 0]))
            context = input_audio[:, -64:]

        raw_regions: list[tuple[int, int]] = []
        start_frame: int | None = None
        quiet_frames = 0
        for frame_index, probability in enumerate(probabilities):
            if start_frame is None:
                if probability >= 0.5:
                    start_frame = frame_index
                continue
            if probability < 0.35:
                quiet_frames += 1
                if quiet_frames >= 9:
                    raw_regions.append((start_frame * VAD_FRAME, (frame_index - quiet_frames + 1) * VAD_FRAME))
                    start_frame = None
                    quiet_frames = 0
            else:
                quiet_frames = 0
        if start_frame is not None:
            raw_regions.append((start_frame * VAD_FRAME, len(waveform)))

        padding = int(0.12 * SAMPLE_RATE)
        regions = []
        for start, end in raw_regions:
            if end - start < int(0.25 * SAMPLE_RATE):
                continue
            padded_start = max(0, start - padding)
            padded_end = min(len(waveform), end + padding)
            if regions and padded_start <= regions[-1][1]:
                regions[-1] = (regions[-1][0], padded_end)
            else:
                regions.append((padded_start, padded_end))
        return regions

    def embedding(self, waveform: np.ndarray) -> list[float]:
        """Average up to three one-second voice samples from a speech turn."""
        window = SAMPLE_RATE
        if len(waveform) < window:
            waveform = np.pad(waveform, (0, window - len(waveform)))
        last_start = len(waveform) - window
        positions = [last_start // 2] if last_start < window else [0, last_start // 2, last_start]
        vectors = []
        for position in positions:
            sample = waveform[position : position + window].astype(np.float32, copy=False)
            result = self.speaker.run(None, {"audio_input": sample.reshape(1, 1, window)})[0][0]
            norm = float(np.linalg.norm(result))
            if norm > 1e-8:
                vectors.append(result / norm)
        if not vectors:
            raise RuntimeError("Could not identify a voice in this speech turn.")
        mean = np.mean(vectors, axis=0)
        mean /= max(float(np.linalg.norm(mean)), 1e-8)
        return mean.astype(np.float32).tolist()

    def analyze(self, waveform: np.ndarray) -> list[dict]:
        regions = self.speech_regions(waveform)
        uncertain = False
        if not regions and len(waveform) and float(np.sqrt(np.mean(np.square(waveform, dtype=np.float64)))) > 0.003:
            regions = [(0, len(waveform))]
            uncertain = True
        return [
            {
                "start": round(start / SAMPLE_RATE, 3),
                "end": round(end / SAMPLE_RATE, 3),
                "embedding": self.embedding(waveform[start:end]),
                "uncertain": uncertain,
                "start_sample": start,
                "end_sample": end,
            }
            for start, end in regions
        ]
