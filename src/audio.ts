const SAMPLE_RATE = 16_000
const SECTION_SECONDS = 15
const OVERLAP_SECONDS = 0.7

export type AudioSection = {
  start: number
  end: number
}

export function audioSections(duration: number): AudioSection[] {
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error('This audio file has no playable sound.')
  }

  const sections: AudioSection[] = []
  const step = SECTION_SECONDS - OVERLAP_SECONDS
  for (let start = 0; start < duration; start += step) {
    const end = Math.min(start + SECTION_SECONDS, duration)
    sections.push({ start, end })
    if (end === duration) break
  }
  return sections
}

export function encodeWavSection(buffer: AudioBuffer, section: AudioSection): Blob {
  const sampleCount = Math.ceil((section.end - section.start) * SAMPLE_RATE)
  const wav = new ArrayBuffer(44 + sampleCount * 2)
  const view = new DataView(wav)

  function writeText(offset: number, value: string) {
    for (let index = 0; index < value.length; index += 1) {
      view.setUint8(offset + index, value.charCodeAt(index))
    }
  }

  writeText(0, 'RIFF')
  view.setUint32(4, 36 + sampleCount * 2, true)
  writeText(8, 'WAVE')
  writeText(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, SAMPLE_RATE, true)
  view.setUint32(28, SAMPLE_RATE * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeText(36, 'data')
  view.setUint32(40, sampleCount * 2, true)

  const channels = Array.from({ length: buffer.numberOfChannels }, (_, index) => buffer.getChannelData(index))
  for (let index = 0; index < sampleCount; index += 1) {
    const sourcePosition = (section.start + index / SAMPLE_RATE) * buffer.sampleRate
    const left = Math.min(Math.floor(sourcePosition), buffer.length - 1)
    const right = Math.min(left + 1, buffer.length - 1)
    const fraction = sourcePosition - left
    let sample = 0

    for (const channel of channels) {
      sample += channel[left] * (1 - fraction) + channel[right] * fraction
    }
    sample = Math.max(-1, Math.min(1, sample / channels.length))
    view.setInt16(44 + index * 2, sample < 0 ? sample * 32768 : sample * 32767, true)
  }

  return new Blob([wav], { type: 'audio/wav' })
}
