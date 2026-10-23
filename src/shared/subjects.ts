export function replySubject(subject: string): string {
  return /^re:/i.test(subject.trim()) ? subject : `Re: ${subject}`
}

export function forwardSubject(subject: string): string {
  return /^fwd?:/i.test(subject.trim()) ? subject : `Fwd: ${subject}`
}
