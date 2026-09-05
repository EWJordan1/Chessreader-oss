# Build from the repository root, not from server/: the process imports the app's own
# UCI parser so that client and server cannot drift.
#   docker build -f server/Dockerfile -t chessreader-engine .
#   docker run -p 8020:8020 -e CR_TOKEN=secret chessreader-engine
FROM node:22-slim

# Stockfish from Debian; set STOCKFISH to point at your own build instead.
RUN apt-get update \
 && apt-get install -y --no-install-recommends stockfish ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY server/package.json ./server/package.json
RUN cd server && npm install --omit=dev
COPY server ./server
COPY src/engine/uci.js ./src/engine/uci.js

ENV PORT=8020
ENV STOCKFISH=/usr/games/stockfish
ENV CR_THREADS=1
ENV CR_HASH=128
ENV CR_ENGINES=2
EXPOSE 8020
USER node
CMD ["node", "server/index.js"]
