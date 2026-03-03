import { useState } from 'react'

export default function CopyJsonButton({ getData }) {
  const [copied, setCopied] = useState(false)

  async function handleCopy() {
    try {
      const json = JSON.stringify(getData(), null, 2)
      await navigator.clipboard.writeText(json)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {}
  }

  return (
    <button className={`copy-json-btn${copied ? ' copied' : ''}`} onClick={handleCopy}>
      {copied ? 'Copied!' : 'Copy JSON'}
    </button>
  )
}
