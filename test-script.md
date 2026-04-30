# Manual / agent test script

Cases to exercise. Each case is independent — start fresh between them
(reload both tabs).

## Setup

1. Start the relay: `deno run --allow-net=127.0.0.1:8080 relay.ts`
2. Open `transfer.html` in two browser tabs/contexts. Call them **A** and **B**.
3. In both tabs, leave the relay URL at `ws://localhost:8080/`.

## Cases

### 1. Text round-trip (A → B)

- A: click **send text**, type `hello world`, click **send**.
- A: a code appears in yellow.
- B: click **receive**, paste the code, click **receive**.
- **Expect:** B shows `hello world` in a `<pre>` block.
- **Expect:** A shows status "sent." in green.
- **Expect:** A's textarea is now empty.

### 2. File round-trip (A → B)

- A: click **send file**, pick any small file (a text file or image works).
- A: click **send**.
- B: click **receive**, paste the code, click **receive**.
- **Expect:** B's browser triggers a download with the original filename.
- **Expect:** Downloaded file has identical bytes to the original.

### 3. Reverse direction (B → A)

- B: click **send text**, type `pong`, click **send**.
- A: click **receive**, paste B's code, click **receive**.
- **Expect:** A shows `pong`.

### 4. Wrong code

- A: send text `secret`.
- B: click **receive**, paste a clearly wrong 22-character code (e.g. all
  zeros: `AAAAAAAAAAAAAAAAAAAAAA`), click **receive**.
- **Expect:** B's status shows an error (relay closed or decrypt failed) and
  the wrong-code session does not interfere with A's session.

### 5. Two pairs in parallel

- Open four tabs: A1, B1, A2, B2.
- A1 sends text `room1` to B1.
- A2 sends text `room2` to B2.
- **Expect:** B1 receives `room1`, B2 receives `room2`. No crossover.

### 6. Unicode text

- A: send text `héllo 🌍 こんにちは`.
- B: receive.
- **Expect:** B displays the exact same string, no mojibake.

### 7. Empty input rejected

- A: click **send text** without typing anything, click **send**.
- **Expect:** Status shows "type some text first." in red.
- A: click **send file** without picking a file, click **send**.
- **Expect:** Status shows "pick a file first." in red.

### 8. Receiver field clears after submit

- B: click **receive**, paste a code, click **receive**.
- **Expect:** Immediately after clicking, the input field is empty.

### 9. Copy & clear (text receive)

- Run case 1.
- B: click **copy & clear**.
- **Expect:** Clipboard contains the received text. The `<pre>` is hidden /
  empty.

### 10. Wrong-direction send (B sends, A's old session lingers)

- A: send text. Don't have B receive yet.
- A: while still showing the code, refresh A.
- B: now try to receive with A's code.
- **Expect:** B's status shows an error (peer left / relay closed).

## Notes

- Browser memory permissions: any modern Chromium / Firefox / Safari
  (latest evergreen) should support all required APIs:
  `crypto.subtle`, `WebSocket`, `crypto.getRandomValues`,
  `URL.createObjectURL`. Tests assume these.
- The textarea / input persistence concerns are best-effort and not
  testable from script — they require a hostile browser scenario.
