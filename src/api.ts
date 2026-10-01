export type AuthUser = {
  id: number
  full_names: string
  phone_number: string
}

export const SESSION_TOKEN_KEY = 'mabab-session-token'

export class ApiResponseError extends Error {
  status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export async function readJsonResponse(response: Response): Promise<Record<string, unknown>> {
  if (response.status === 204) return {}
  let body: unknown
  try {
    body = await response.json()
  } catch {
    if (response.ok) {
      if (response.headers.get('content-type')?.toLowerCase().includes('text/html')) {
        throw new Error('The server returned a web page for an API request. Deploy the Node server as a Render Web Service so /api routes are available.')
      }
      throw new Error('The API returned an unreadable response. Check the deployed backend route.')
    }
    return {}
  }
  if (body !== null && typeof body === 'object' && !Array.isArray(body)) {
    return body as Record<string, unknown>
  }
  if (response.ok) throw new Error('The API returned JSON in an unexpected format.')
  return {}
}

export function apiErrorMessage(body: Record<string, unknown>, fallback: string): string {
  if (typeof body.error === 'string') return body.error
  if (typeof body.detail === 'string') return body.detail
  if (Array.isArray(body.detail)) {
    const messages = body.detail
      .map((item) => item && typeof item === 'object' && 'msg' in item ? item.msg : null)
      .filter((message): message is string => typeof message === 'string')
    if (messages.length) return messages.join(' ')
  }
  return fallback
}

export function requireApiSuccess(response: Response, body: Record<string, unknown>, fallback: string): void {
  if (!response.ok) throw new ApiResponseError(response.status, apiErrorMessage(body, fallback))
}

export function bearerHeaders(token: string): { Authorization: string } {
  return { Authorization: `Bearer ${token}` }
}
