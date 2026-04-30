# Manual / agent test script

Cases to exercise. Each case is independent — start fresh between them
(reload both tabs).

## Setup

1. Start the relay: `deno run --allow-net=127.0.0.1:8080 relay.ts`
2. Open `transfer.html?relay=ws://localhost:8080/` in two browser
   tabs/contexts. Call them **A** and **B**. The query param overrides
   the hardcoded default to point both tabs at the local relay.
3. Confirm the relay field at the top of each page shows
   `ws://localhost:8080/`.

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
  A's: `AAAAAAAAAAAAAAAAAAAAAA`), click **receive**.
- **Expect (immediate):** B shows "waiting for sender..." (correct: the
  wrong code derives a different room ID, so B joins an empty room).
- **Expect (after timeout, ~90s):** B's status flips to an error like
  "no peer joined within 90s; check the code and try again." The button
  is re-enabled. A's session is unaffected.

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
- **Expect:** The `<pre>` is hidden, its text is empty.
- **Expect (manual):** Pasting elsewhere yields the received text.
  (Programmatic clipboard reads are unreliable in headless, so this part
  is verified by eye.)

### 10. Sender refresh-mid-send

- A: send text. Don't have B receive yet.
- A: while still showing the code, refresh the page.
- B: now try to receive with A's old code.
- **Expect (immediate):** B shows "waiting for sender..." (the room A was
  in is gone; B is alone in a new room with the same ID).
- **Expect (after timeout, ~90s):** Same timeout error as case 4.

## Notes

- Browser memory permissions: any modern Chromium / Firefox / Safari
  (latest evergreen) should support all required APIs:
  `crypto.subtle`, `WebSocket`, `crypto.getRandomValues`,
  `URL.createObjectURL`. Tests assume these.
- The textarea / input persistence concerns are best-effort and not
  testable from script — they require a hostile browser scenario.
