FROM denoland/deno:alpine-2.7.14

WORKDIR /app
COPY deno.json deno.lock relay.ts ./

# Cache the script + npm:ws dep with integrity checked against deno.lock.
RUN deno cache --frozen relay.ts

# The client page, served by the relay at "/" so the page and the wss endpoint
# share one origin. Copied after the cache step so page edits don't bust the
# dependency layer.
COPY transfer.html ./

EXPOSE 8080

# Bind to 0.0.0.0 inside the container; Fly forwards 443/wss to 8080.
# Outbound 443 to the sidecar host is allowed so the relay can POST byte
# deltas to /report and GET /status. Without that allowance the sidecar
# integration silently fails open (which is the correct fallback, but
# leaves the cap unenforced).
CMD ["run", "--frozen", "--allow-read=transfer.html", "--allow-net=0.0.0.0:8080,transfer-html-sidecar.transfer-html.workers.dev:443", "--allow-env=WS_NO_BUFFER_UTIL,WS_NO_UTF_8_VALIDATE,NODE_ENV,SIDECAR_URL,SIDECAR_TOKEN", "relay.ts"]
