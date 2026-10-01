"""Persistent local Kinyarwanda ASR worker used by server.mjs."""

import base64
import io
import json
import os
import sys
import wave

import numpy as np
import onnx_asr
import onnxruntime as ort
from text_cleanup import format_transcript
from voice_diarization import VoiceAnalyzer


MODEL_ID = os.environ.get(
    "LOCAL_ASR_MODEL",
    "OpenVoiceOS/w2v-bert-2.0-kinyarwanda-onnx",
)
MODEL_PATH = os.environ.get("LOCAL_ASR_MODEL_PATH") or None


def send(payload: dict) -> None:
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def decode_wav(encoded_audio: str) -> tuple[np.ndarray, int]:
    audio_bytes = base64.b64decode(encoded_audio, validate=True)
    with wave.open(io.BytesIO(audio_bytes), "rb") as wav_file:
        channels = wav_file.getnchannels()
        sample_width = wav_file.getsampwidth()
        sample_rate = wav_file.getframerate()
        frames = wav_file.readframes(wav_file.getnframes())

    if sample_width != 2:
        raise ValueError("The local model requires 16-bit PCM WAV audio.")

    waveform = np.frombuffer(frames, dtype="<i2").astype(np.float32) / 32768.0
    if channels > 1:
        waveform = waveform.reshape(-1, channels).mean(axis=1)
    return waveform, sample_rate


def load_model():
    print(f"Loading {MODEL_ID} on the local CPU...", file=sys.stderr, flush=True)
    session_options = ort.SessionOptions()
    session_options.intra_op_num_threads = max(1, min(4, os.cpu_count() or 1))
    session_options.inter_op_num_threads = 1
    session_options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    model = onnx_asr.load_model(
        MODEL_ID,
        MODEL_PATH,
        quantization="int8",
        sess_options=session_options,
    )
    print("Local Kinyarwanda model is ready.", file=sys.stderr, flush=True)
    return model


def main() -> None:
    model = None
    voice_analyzer = None
    for line in sys.stdin:
        request_id = None
        try:
            request = json.loads(line)
            request_id = request.get("id")
            task = request.get("task", "transcribe")
            if task == "clean":
                text = request.get("text")
                if not isinstance(text, str):
                    raise ValueError("A transcript is required for formatting.")
                send({"id": request_id, "text": format_transcript(text)})
                continue
            if task != "transcribe":
                raise ValueError("Unknown worker task.")
            waveform, sample_rate = decode_wav(request["audio"])
            if sample_rate != 16_000:
                raise ValueError("Voice analysis requires 16 kHz audio.")
            if model is None:
                model = load_model()
            if voice_analyzer is None:
                print("Loading local voice activity and speaker models...", file=sys.stderr, flush=True)
                voice_analyzer = VoiceAnalyzer()
            segments = []
            for region in voice_analyzer.analyze(waveform):
                speech = waveform[region.pop("start_sample") : region.pop("end_sample")]
                transcript = model.recognize(speech, sample_rate=sample_rate)
                text = transcript if isinstance(transcript, str) else str(transcript)
                segments.append({**region, "text": text.strip()})
            send({"id": request_id, "text": " ".join(item["text"] for item in segments if item["text"]), "segments": segments})
        except Exception as error:
            send({"id": request_id, "error": str(error)})


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"Local model failed to start: {error}", file=sys.stderr, flush=True)
        sys.exit(1)
