FROM denoland/deno:alpine-2.7.14

WORKDIR /app
COPY deno.json deno.lock relay.ts ./

# Cache the script + npm:ws dep with integrity checked against deno.lock.
RUN deno cache --frozen relay.ts

EXPOSE 8080

# Bind to 0.0.0.0 inside the container; Fly forwards 443/wss to 8080.
CMD ["run", "--frozen", "--allow-net=0.0.0.0:8080", "--allow-env=WS_NO_BUFFER_UTIL,WS_NO_UTF_8_VALIDATE,NODE_ENV", "relay.ts"]
