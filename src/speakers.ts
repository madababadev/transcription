import { mergeTranscript } from './transcript'

export type Speaker = 'Moderator' | 'Responder'

export type VoiceSegment = {
  start: number
  end: number
  text: string
  embedding: number[]
  uncertain: boolean
}

export type DialogueTurn = {
  speaker: Speaker
  text: string
}

function unitVector(values: number[]): number[] {
  const magnitude = Math.hypot(...values)
  if (!Number.isFinite(magnitude) || magnitude < 1e-8) throw new Error('A speech turn has no usable voice signature.')
  return values.map((value) => value / magnitude)
}

function similarity(left: number[], right: number[]): number {
  return left.reduce((sum, value, index) => sum + value * right[index], 0)
}

export function voiceSegmentsFromResponse(value: unknown, sectionStart: number): VoiceSegment[] {
  if (!Array.isArray(value)) throw new Error('The local voice analyzer returned no speech segments.')
  return value.map((item): VoiceSegment => {
    if (!item || typeof item !== 'object') throw new Error('The local voice analyzer returned an invalid speech segment.')
    const segment = item as Record<string, unknown>
    if (typeof segment.start !== 'number' || typeof segment.end !== 'number' ||
      !Number.isFinite(segment.start) || !Number.isFinite(segment.end) || segment.end <= segment.start ||
      typeof segment.text !== 'string' || !Array.isArray(segment.embedding) || segment.embedding.length !== 512 ||
      !segment.embedding.every((number) => typeof number === 'number' && Number.isFinite(number))) {
      throw new Error('The local voice analyzer returned an invalid speech segment.')
    }
    return {
      start: sectionStart + segment.start,
      end: sectionStart + segment.end,
      text: segment.text.trim(),
      embedding: segment.embedding,
      uncertain: segment.uncertain === true,
    }
  })
}

export function dialogueFromVoices(segments: VoiceSegment[]): DialogueTurn[] {
  if (!segments.length) return []
  const ordered = [...segments].sort((left, right) => left.start - right.start)
  const vectors = ordered.map((segment) => unitVector(segment.embedding))
  const first = vectors[0]
  let secondIndex = 0
  let lowestSimilarity = 1
  for (let index = 1; index < vectors.length; index += 1) {
    const score = similarity(first, vectors[index])
    if (score < lowestSimilarity) {
      lowestSimilarity = score
      secondIndex = index
    }
  }

  const assignments = Array(vectors.length).fill(0) as number[]
  if (secondIndex !== 0 && lowestSimilarity < 0.75) {
    let centers = [first, vectors[secondIndex]]
    for (let iteration = 0; iteration < 20; iteration += 1) {
      let changed = false
      for (let index = 0; index < vectors.length; index += 1) {
        const next = similarity(vectors[index], centers[1]) > similarity(vectors[index], centers[0]) ? 1 : 0
        if (assignments[index] !== next) changed = true
        assignments[index] = next
      }
      assignments[0] = 0
      assignments[secondIndex] = 1
      if (!changed && iteration > 0) break
      centers = [0, 1].map((cluster) => {
        const members = vectors.filter((_, index) => assignments[index] === cluster)
        const mean = first.map((_, dimension) => members.reduce((sum, vector) => sum + vector[dimension], 0) / members.length)
        return unitVector(mean)
      })
    }
  }

  const turns: DialogueTurn[] = []
  for (let index = 0; index < ordered.length; index += 1) {
    const speaker: Speaker = assignments[index] === 0 ? 'Moderator' : 'Responder'
    const text = ordered[index].text.trim()
    if (!text) continue
    if (turns.at(-1)?.speaker === speaker) turns[turns.length - 1].text = mergeTranscript(turns.at(-1)!.text, text)
    else turns.push({ speaker, text })
  }
  return turns
}

export function dialogueText(turns: DialogueTurn[]): string {
  return turns.map((turn) => `${turn.speaker}: ${turn.text}`).join('\n\n')
}

export function parseDialogueText(text: string): DialogueTurn[] | null {
  const blocks = text.trim().split(/\r?\n\s*\r?\n/)
  const turns: DialogueTurn[] = []
  for (const block of blocks) {
    const match = /^(Moderator|Responder):\s*([\s\S]+)$/.exec(block.trim())
    if (!match) return null
    turns.push({ speaker: match[1] as Speaker, text: match[2].replace(/\s+/g, ' ').trim() })
  }
  return turns.length ? turns : null
}
