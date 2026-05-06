let countdownInterval: ReturnType<typeof setInterval> | null = null
let lastLineWasCountdown = false

function clearCountdown() {
  if (countdownInterval !== null) {
    clearInterval(countdownInterval)
    countdownInterval = null
  }
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${s.toString().padStart(2, "0")}`
}

export function showPairingCode(code: string, expiresIn: number, onExpired: () => void) {
  clearCountdown()

  const formatted = code.length === 6
    ? `${code.slice(0, 3)} - ${code.slice(3)}`
    : code

  process.stderr.write(
    "\n" +
    "╔══════════════════════════════════════╗\n" +
    "║                                      ║\n" +
    "║   NURA DEV                           ║\n" +
    "║   nuradev.app                        ║\n" +
    "║                                      ║\n" +
    "║   Pairing code:                      ║\n" +
    "║                                      ║\n" +
    `║          ${formatted.padEnd(28)}║\n` +
    "║                                      ║\n" +
    "║   1. Open nuradev.app                ║\n" +
    "║      on your phone                   ║\n" +
    "║   2. Tap  +  and enter this code     ║\n" +
    "║                                      ║\n" +
    `║   Expires in  ${formatTime(expiresIn).padEnd(23)}║\n` +
    "║                                      ║\n" +
    "╚══════════════════════════════════════╝\n"
  )

  let remaining = expiresIn - 1
  lastLineWasCountdown = false

  countdownInterval = setInterval(() => {
    if (remaining <= 0) {
      clearCountdown()
      if (lastLineWasCountdown) process.stderr.write("\n")
      process.stderr.write("Code expired. Requesting a new one...\n")
      lastLineWasCountdown = false
      onExpired()
      return
    }

    process.stderr.write(`\r   Expires in  ${formatTime(remaining)}   `)
    lastLineWasCountdown = true
    remaining--
  }, 1000)
}

const BOX_LINES = 16

export function clearPairingBox() {
  clearCountdown()
  if (lastLineWasCountdown) {
    process.stderr.write("\n")
    lastLineWasCountdown = false
  }
  // Move cursor up and clear lines
  for (let i = 0; i < BOX_LINES; i++) {
    process.stderr.write("\x1b[1A\x1b[2K")
  }
}

export function showPaired() {
  clearCountdown()
  process.stderr.write(
    "✓ Nura Dev paired — ready\n" +
    "  Listening for voice commands from nuradev.app\n"
  )
}

export function showDisconnected() {
  process.stderr.write(
    "○ Nura Dev disconnected\n" +
    "  Waiting for reconnect from nuradev.app...\n"
  )
}

export function showReconnected() {
  process.stderr.write("✓ Nura Dev reconnected\n")
}
