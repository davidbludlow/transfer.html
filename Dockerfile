FROM denoland/deno:alpine-2.1.4

WORKDIR /app
COPY relay.ts .

# Cache the script so it doesn't re-parse on every cold start.
RUN deno cache relay.ts

EXPOSE 8080

# Bind to 0.0.0.0 inside the container; Fly forwards 443/wss to 8080.
CMD ["run", "--allow-net=0.0.0.0:8080", "relay.ts"]
