function normalizedWord(word: string): string {
  return word.toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
}

export function mergeTranscript(previous: string, incoming: string): string {
  const current = previous.trim()
  const next = incoming.trim()
  if (!current) return next
  if (!next) return current

  const oldWords = current.split(/\s+/)
  const newWords = next.split(/\s+/)
  const maximumOverlap = Math.min(12, oldWords.length, newWords.length)
  let overlap = 0

  for (let length = maximumOverlap; length > 0; length -= 1) {
    const matches = oldWords.slice(-length).every((word, index) => {
      const oldWord = normalizedWord(word)
      return oldWord.length > 0 && oldWord === normalizedWord(newWords[index])
    })
    if (matches) {
      overlap = length
      break
    }
  }

  return [current, newWords.slice(overlap).join(' ')].filter(Boolean).join(' ')
}
