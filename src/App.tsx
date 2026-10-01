import { useEffect, useRef, useState } from 'react'
import type { ChangeEvent, DragEvent } from 'react'
import AuthScreen from './AuthScreen'
import { ApiResponseError, bearerHeaders, readJsonResponse, requireApiSuccess, SESSION_TOKEN_KEY } from './api'
import type { AuthUser } from './api'
import { audioSections, encodeWavSection } from './audio'
import { dialogueFromVoices, dialogueText, parseDialogueText, voiceSegmentsFromResponse } from './speakers'
import type { DialogueTurn, VoiceSegment } from './speakers'
import { mergeTranscript } from './transcript'

const MAX_FILE_BYTES = 200 * 1024 * 1024
const SUPPORTED_EXTENSIONS = new Set(['flac', 'mp3', 'mp4', 'mpeg', 'mpga', 'm4a', 'ogg', 'wav', 'webm'])

type Phase = 'idle' | 'decoding' | 'transcribing' | 'formatting' | 'done' | 'error'
type AuthState =
  | { status: 'checking'; token: string }
  | { status: 'anonymous' }
  | { status: 'authenticated'; token: string; user: AuthUser }

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong. Please try again.'
}

function storedToken(): string | null {
  try {
    return window.sessionStorage.getItem(SESSION_TOKEN_KEY)
  } catch {
    return null
  }
}

async function fetchUsageCount(token: string): Promise<number | null> {
  const response = await fetch('/api/me/usage?limit=1', { headers: bearerHeaders(token) })
  const body = await readJsonResponse(response)
  requireApiSuccess(response, body, 'Could not load request usage.')
  return typeof body.total_requests === 'number' ? body.total_requests : null
}

async function requestDialogue(turns: DialogueTurn[], token: string, signal: AbortSignal): Promise<string> {
  const response = await fetch('/api/format-dialogue', {
    method: 'POST',
    headers: { ...bearerHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ turns }),
    signal,
  })
  const result = await readJsonResponse(response)
  requireApiSuccess(response, result, `Dialogue formatting failed (${response.status}).`)
  if (typeof result.text !== 'string' || !result.text.trim()) {
    throw new Error('Dialogue formatting returned an empty transcript.')
  }
  return result.text
}

function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60)
  const remaining = Math.round(seconds % 60)
  return `${minutes}:${String(remaining).padStart(2, '0')}`
}

export default function App() {
  const [auth, setAuth] = useState<AuthState>(() => {
    const token = storedToken()
    return token ? { status: 'checking', token } : { status: 'anonymous' }
  })
  const [authNotice, setAuthNotice] = useState('')
  const [usageCount, setUsageCount] = useState<number | null>(null)
  const [file, setFile] = useState<File | null>(null)
  const [transcript, setTranscript] = useState('')
  const [originalTranscript, setOriginalTranscript] = useState('')
  const [phase, setPhase] = useState<Phase>('idle')
  const [error, setError] = useState('')
  const [completedSections, setCompletedSections] = useState(0)
  const [totalSections, setTotalSections] = useState(0)
  const [duration, setDuration] = useState(0)
  const [cleaned, setCleaned] = useState(false)
  const [voiceTurns, setVoiceTurns] = useState<DialogueTurn[]>([])
  const [voiceWarning, setVoiceWarning] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const busy = phase === 'decoding' || phase === 'transcribing' || phase === 'formatting'
  const wordCount = transcript.trim() ? transcript.trim().split(/\s+/).length : 0

  useEffect(() => {
    if (auth.status !== 'checking') return
    const token = auth.token
    let cancelled = false
    async function verifySession() {
      try {
        const response = await fetch('/api/me', { headers: bearerHeaders(token) })
        const body = await readJsonResponse(response)
        requireApiSuccess(response, body, 'Could not verify your session.')
        const user = body as AuthUser
        if (typeof user.id !== 'number') throw new Error('The account service returned an invalid user.')
        let count: number | null = null
        try {
          count = await fetchUsageCount(token)
        } catch { /* The workspace can still open without the usage summary. */ }
        if (cancelled) return
        setUsageCount(count)
        setAuth({ status: 'authenticated', token, user })
      } catch (caught) {
        if (cancelled) return
        window.sessionStorage.removeItem(SESSION_TOKEN_KEY)
        setAuth({ status: 'anonymous' })
        setAuthNotice(errorMessage(caught))
      }
    }
    void verifySession()
    return () => { cancelled = true }
  }, [auth])

  function clearSession(notice = '') {
    abortRef.current?.abort()
    window.sessionStorage.removeItem(SESSION_TOKEN_KEY)
    setAuth({ status: 'anonymous' })
    setAuthNotice(notice)
    setUsageCount(null)
    setFile(null)
    setTranscript('')
    setOriginalTranscript('')
    setVoiceTurns([])
    setVoiceWarning(false)
    setPhase('idle')
  }

  function refreshUsage(token: string) {
    void fetchUsageCount(token)
      .then((count) => { if (storedToken() === token) setUsageCount(count) })
      .catch(() => { if (storedToken() === token) setUsageCount(null) })
  }

  function onAuthenticated(token: string, user: AuthUser) {
    window.sessionStorage.setItem(SESSION_TOKEN_KEY, token)
    setAuth({ status: 'authenticated', token, user })
    setAuthNotice('')
    refreshUsage(token)
  }

  function signOut() {
    if (auth.status !== 'authenticated') return
    const token = auth.token
    clearSession()
    void fetch('/api/logout', { method: 'POST', headers: bearerHeaders(token) }).catch(() => {})
  }

  function chooseFile(selected: File | null) {
    if (!selected || busy) return
    const extension = selected.name.split('.').at(-1)?.toLowerCase() || ''
    if (!SUPPORTED_EXTENSIONS.has(extension)) {
      setError('Choose a FLAC, MP3, MP4, MPEG, MPGA, M4A, OGG, WAV, or WebM file.')
      setPhase('error')
      return
    }
    if (selected.size === 0 || selected.size > MAX_FILE_BYTES) {
      setError('Choose a nonempty audio file smaller than 200 MB.')
      setPhase('error')
      return
    }
    setFile(selected)
    setTranscript('')
    setOriginalTranscript('')
    setVoiceTurns([])
    setVoiceWarning(false)
    setCompletedSections(0)
    setTotalSections(0)
    setDuration(0)
    setCleaned(false)
    setError('')
    setPhase('idle')
  }

  function onFileChange(event: ChangeEvent<HTMLInputElement>) {
    chooseFile(event.target.files?.[0] || null)
    event.target.value = ''
  }

  function onDrop(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault()
    chooseFile(event.dataTransfer.files?.[0] || null)
  }

  async function transcribe() {
    if (!file || busy || auth.status !== 'authenticated') return
    const token = auth.token
    const controller = new AbortController()
    abortRef.current = controller
    setError('')
    setPhase('decoding')
    setCompletedSections(0)
    setTranscript('')
    setOriginalTranscript('')
    setVoiceTurns([])
    setVoiceWarning(false)
    setCleaned(false)
    let audioContext: AudioContext | null = null
    let requestId: number | null = null
    let dialogueError = ''

    try {
      const startResponse = await fetch('/api/transcription-requests', {
        method: 'POST',
        headers: bearerHeaders(token),
      })
      const startBody = await readJsonResponse(startResponse)
      requireApiSuccess(startResponse, startBody, 'Could not start the transcription request.')
      if (typeof startBody.id !== 'number') throw new Error('The account service did not return a request ID.')
      requestId = startBody.id

      audioContext = new AudioContext()
      const audio = await audioContext.decodeAudioData(await file.arrayBuffer())
      if (controller.signal.aborted) throw new DOMException('Transcription stopped.', 'AbortError')
      const sections = audioSections(audio.duration)
      setDuration(audio.duration)
      setTotalSections(sections.length)
      setPhase('transcribing')

      let accumulated = ''
      const voiceSegments: VoiceSegment[] = []
      let uncertainVoice = false
      for (let index = 0; index < sections.length; index += 1) {
        if (controller.signal.aborted) throw new DOMException('Transcription stopped.', 'AbortError')
        const wav = encodeWavSection(audio, sections[index])
        const response = await fetch('/api/transcribe', {
          method: 'POST',
          headers: {
            ...bearerHeaders(token),
            'Content-Type': 'audio/wav',
            'X-Transcription-Request-Id': String(requestId),
          },
          body: wav,
          signal: controller.signal,
        })
        const result = await readJsonResponse(response)
        requireApiSuccess(response, result, `Transcription failed (${response.status}).`)
        const newSegments = voiceSegmentsFromResponse(result.segments, sections[index].start)
        if (newSegments.some((segment) => segment.uncertain)) uncertainVoice = true
        const midpoint = (section: VoiceSegment) => (section.start + section.end) / 2
        const keptSegments = newSegments.filter((segment) =>
          (index === 0 || midpoint(segment) >= sections[index].start + 0.35) &&
          (index === sections.length - 1 || midpoint(segment) <= sections[index].end - 0.35))
        voiceSegments.push(...keptSegments)
        accumulated = mergeTranscript(accumulated, typeof result.text === 'string' ? result.text : '')
        setTranscript(accumulated)
        setOriginalTranscript(accumulated)
        setCompletedSections(index + 1)
      }
      let voiceTurnCount = 0
      setVoiceWarning(uncertainVoice)
      if (voiceSegments.length) {
        const turns = dialogueFromVoices(voiceSegments)
        voiceTurnCount = turns.length
        const rawDialogue = dialogueText(turns)
        setVoiceTurns(turns)
        setOriginalTranscript(rawDialogue)
        setTranscript(rawDialogue)
        if (turns.length) {
          setPhase('formatting')
          try {
            const dialogue = await requestDialogue(turns, token, controller.signal)
            setTranscript(dialogue)
            setCleaned(true)
          } catch (caught) {
            if (controller.signal.aborted || (caught instanceof ApiResponseError && caught.status === 401)) throw caught
            dialogueError = `The voice-labeled transcript is ready, but text polishing failed. ${errorMessage(caught)}`
          }
        }
      }
      if (!voiceTurnCount) {
        dialogueError = 'No clear speech was detected. Try a recording with the voices closer to the microphone.'
      }
      const finishResponse = await fetch(`/api/transcription-requests/${requestId}/finish`, {
        method: 'POST',
        headers: { ...bearerHeaders(token), 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'completed' }),
      })
      const finishBody = await readJsonResponse(finishResponse)
      requireApiSuccess(finishResponse, finishBody, 'Could not finish the transcription request.')
      requestId = null
      refreshUsage(token)
      setPhase('done')
      if (dialogueError) setError(dialogueError)
    } catch (caught) {
      if (requestId !== null) {
        const failedRequestId = requestId
        try {
          await fetch(`/api/transcription-requests/${failedRequestId}/finish`, {
            method: 'POST',
            headers: { ...bearerHeaders(token), 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: 'failed' }),
          })
          refreshUsage(token)
        } catch { /* The started request remains visible in usage history. */ }
      }
      if (caught instanceof ApiResponseError && caught.status === 401) {
        clearSession('Your session expired. Sign in again.')
        return
      }
      if (controller.signal.aborted) {
        setPhase('idle')
      } else {
        setError(errorMessage(caught))
        setPhase('error')
      }
    } finally {
      if (audioContext) await audioContext.close()
      if (abortRef.current === controller) abortRef.current = null
    }
  }

  async function formatTranscript() {
    const current = transcript.trim()
    if (!current || !voiceTurns.length || busy || auth.status !== 'authenticated') return
    const token = auth.token
    const controller = new AbortController()
    abortRef.current = controller
    setError('')
    setPhase('formatting')
    try {
      const turns = parseDialogueText(current)
      if (!turns) throw new Error('Keep each Moderator: or Responder: turn in a separate paragraph before formatting.')
      const formatted = await requestDialogue(turns, token, controller.signal)
      setTranscript(formatted)
      setCleaned(true)
      setPhase('done')
    } catch (caught) {
      if (caught instanceof ApiResponseError && caught.status === 401) {
        clearSession('Your session expired. Sign in again.')
        return
      }
      if (controller.signal.aborted) {
        setPhase('done')
      } else {
        setError(errorMessage(caught))
        setPhase('done')
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null
    }
  }

  async function downloadDocx() {
    const text = transcript.trim()
    if (!text) return
    try {
      setError('')
      const { Document, Packer, Paragraph, TextRun } = await import('docx')
      const paragraphs = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => new Paragraph({
        children: [new TextRun(line)],
        spacing: { after: 220 },
      }))
      const wordDocument = new Document({
        title: 'Kinyarwanda transcript',
        creator: 'Mabab Transcription',
        description: originalTranscript ? `Original ASR transcript: ${originalTranscript}` : undefined,
        sections: [{ children: paragraphs }],
      })
      const blob = await Packer.toBlob(wordDocument)
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      const stem = file?.name.replace(/\.[^.]+$/, '').replace(/[^\p{L}\p{N}._-]+/gu, '-') || 'transcript'
      link.href = url
      link.download = `${stem}-transcript.docx`
      document.body.appendChild(link)
      link.click()
      link.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (caught) {
      setError(errorMessage(caught))
      setPhase('error')
    }
  }

  const statusText = phase === 'decoding'
    ? 'Preparing audio in your browser…'
    : phase === 'transcribing'
      ? `Transcribing section ${Math.min(completedSections + 1, totalSections)} of ${totalSections}…`
      : phase === 'formatting'
        ? 'Grouping Moderator and Responder dialogue…'
        : phase === 'done'
          ? !transcript.trim() ? 'No clear speech detected.' : voiceWarning ? 'Review voice labels · unclear audio in some sections.' : cleaned ? 'Review voice labels before export · text polished with OpenAI.' : 'Voice-labeled transcript ready to review and export.'
          : 'Ready when you are.'

  if (auth.status !== 'authenticated') {
    return (
      <main className="app-shell">
        <header className="site-header">
          <div className="brand-mark" aria-hidden="true"><span /><span /><span /><span /></div>
          <div className="brand-copy"><strong>Mabab</strong><span>Transcription workspace</span></div>
          <div className="privacy-pill"><span className="privacy-dot" /> Audio stays on this computer</div>
        </header>
        {auth.status === 'checking'
          ? <section className="panel auth-loading" role="status">Checking your session…</section>
          : <AuthScreen notice={authNotice} onAuthenticated={onAuthenticated} />}
        <footer className="site-footer"><span>Mabab Transcription</span><span>Local audio transcription · online dialogue formatting</span></footer>
      </main>
    )
  }

  return (
    <main className="app-shell app-shell-workspace">
      <header className="site-header site-header-workspace">
        <div className="brand-mark" aria-hidden="true"><span /><span /><span /><span /></div>
        <div className="brand-copy"><strong>Mabab</strong><h1>Kinyarwanda transcription</h1></div>
        <div className="account-bar">
          <span>Signed in as</span>
          <strong title={auth.user.full_names}>{auth.user.full_names}</strong>
          <span className="account-count">{usageCount === null ? 'Requests unavailable' : `${usageCount} ${usageCount === 1 ? 'request' : 'requests'}`}</span>
          <button className="button button-quiet" type="button" onClick={signOut}>Sign out</button>
        </div>
      </header>

      <div className="workspace-grid">
        <section className="panel source-panel" aria-labelledby="source-title">
          <div className="section-heading"><span className="step-number">01</span><h2 id="source-title">Your recording</h2></div>
          <label className={`drop-zone${busy ? ' is-disabled' : ''}`} onDragOver={(event) => event.preventDefault()} onDrop={onDrop}>
            <input type="file" accept=".flac,.mp3,.mp4,.mpeg,.mpga,.m4a,.ogg,.wav,.webm,audio/*,video/mp4" onChange={onFileChange} disabled={busy} />
            <span className="upload-icon" aria-hidden="true">↥</span>
            <strong>{file ? file.name : 'Click to choose or drop a file'}</strong>
            <span>{file ? `${(file.size / (1024 * 1024)).toFixed(1)} MB${duration ? ` · ${formatDuration(duration)}` : ''}` : 'FLAC, MP3, MP4, M4A, OGG, WAV, or WebM · up to 200 MB'}</span>
          </label>
          <div className="source-actions">
            <button className="button button-primary" onClick={transcribe} disabled={!file || busy}>{phase === 'transcribing' ? 'Transcribing…' : 'Start transcription'}<span aria-hidden="true">→</span></button>
            {busy && <button className="button button-quiet" onClick={() => abortRef.current?.abort()}>Stop</button>}
          </div>
          <div className="status-line" role="status"><span className={busy ? 'status-indicator active' : 'status-indicator'} />{statusText}</div>
          {totalSections > 0 && <div className="progress-track" role="progressbar" aria-valuemin={0} aria-valuemax={totalSections} aria-valuenow={completedSections}><span style={{ width: `${(completedSections / totalSections) * 100}%` }} /></div>}
        </section>

        <section className="panel transcript-panel" aria-labelledby="transcript-title">
          <div className="section-heading"><span className="step-number">02</span><h2 id="transcript-title">Transcript</h2></div>
          <label className="editor-label" htmlFor="transcript-editor">Editable text <span>{wordCount} {wordCount === 1 ? 'word' : 'words'}</span></label>
          <textarea id="transcript-editor" value={transcript} onChange={(event) => { setTranscript(event.target.value); setCleaned(false) }} readOnly={busy} placeholder="Speech appears here while the audio is processed. Speaker labels are added after voice analysis finishes." spellCheck lang="rw" />
          <div className="transcript-actions">
            <button className="button button-secondary" onClick={formatTranscript} disabled={!transcript.trim() || !voiceTurns.length || busy}>Polish dialogue</button>
            {cleaned && originalTranscript && <button className="button button-quiet" onClick={() => { setTranscript(originalTranscript); setCleaned(false) }} disabled={busy}>Restore original</button>}
            <button className="button button-primary export-button" onClick={downloadDocx} disabled={!transcript.trim() || busy}>Download Word <span aria-hidden="true">↓</span></button>
          </div>
        </section>
      </div>

      {error && <div className="error-banner" role="alert"><strong>Could not complete that step.</strong><span>{error}</span></div>}
    </main>
  )
}
