FROM node:22-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-pip ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -m pip install --pre --break-system-packages --no-cache-dir "yt-dlp[default]"

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY server.js ./

ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "server.js"]
