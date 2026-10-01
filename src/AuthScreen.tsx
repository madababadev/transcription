import { useState } from 'react'
import type { FormEvent } from 'react'
import { readJsonResponse, requireApiSuccess } from './api'
import type { AuthUser } from './api'

type AuthScreenProps = {
  notice: string
  onAuthenticated: (token: string, user: AuthUser) => void
}

export default function AuthScreen({ notice, onAuthenticated }: AuthScreenProps) {
  const [mode, setMode] = useState<'login' | 'signup'>('login')
  const [fullNames, setFullNames] = useState('')
  const [phoneNumber, setPhoneNumber] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setError('')
    try {
      if (mode === 'signup') {
        const signupResponse = await fetch('/api/signup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ full_names: fullNames, phone_number: phoneNumber, password }),
        })
        const signupBody = await readJsonResponse(signupResponse)
        requireApiSuccess(signupResponse, signupBody, 'Could not create the account.')
      }

      const loginResponse = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone_number: phoneNumber, password }),
      })
      const loginBody = await readJsonResponse(loginResponse)
      requireApiSuccess(loginResponse, loginBody, 'Could not sign in.')
      const user = loginBody.user as AuthUser | undefined
      if (typeof loginBody.access_token !== 'string' || !user || typeof user.id !== 'number') {
        throw new Error('The account service returned an invalid session.')
      }
      setPassword('')
      onAuthenticated(loginBody.access_token, user)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not sign in.')
    } finally {
      setBusy(false)
    }
  }

  function changeMode(next: 'login' | 'signup') {
    setMode(next)
    setError('')
  }

  return (
    <section className="auth-layout" aria-labelledby="auth-title">
      <div className="auth-intro">
        <div className="eyebrow">KINYARWANDA · LOCAL TRANSCRIPTION</div>
        <h1>Welcome to your<br /><em>transcription workspace.</em></h1>
        <p>Audio stays on this computer. Transcript text is sent to OpenAI for dialogue formatting; request times and durations are saved to your account.</p>
      </div>
      <div className="panel auth-panel">
        <h2 id="auth-title">{mode === 'login' ? 'Sign in' : 'Create account'}</h2>
        <p className="auth-description">{mode === 'login' ? 'Use your phone number and password.' : 'Enter your full names, phone number, and password.'}</p>
        <form onSubmit={submit} className="auth-form">
          {mode === 'signup' && (
            <label>Full names
              <input type="text" autoComplete="name" value={fullNames} onChange={(event) => setFullNames(event.target.value)} minLength={2} maxLength={200} required disabled={busy} />
            </label>
          )}
          <label>Phone number
            <input type="tel" autoComplete="tel" value={phoneNumber} onChange={(event) => setPhoneNumber(event.target.value)} placeholder="+250788123456" required disabled={busy} />
          </label>
          <label>Password
            <input type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} value={password} onChange={(event) => setPassword(event.target.value)} minLength={8} required disabled={busy} />
          </label>
          {(error || notice) && <p className="auth-error" role="alert">{error || notice}</p>}
          <button className="button button-primary auth-submit" type="submit" disabled={busy}>{busy ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create account'}</button>
        </form>
        <p className="auth-switch">
          {mode === 'login' ? 'New here?' : 'Already have an account?'}{' '}
          <button type="button" onClick={() => changeMode(mode === 'login' ? 'signup' : 'login')} disabled={busy}>
            {mode === 'login' ? 'Create account' : 'Sign in'}
          </button>
        </p>
      </div>
    </section>
  )
}
