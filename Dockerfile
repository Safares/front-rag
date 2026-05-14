FROM node:20-slim

# Python + pip
RUN apt-get update && apt-get install -y \
    python3 python3-pip python3-venv \
    --no-install-recommends && \
    rm -rf /var/lib/apt/lists/* && \
    ln -s /usr/bin/python3 /usr/bin/python

WORKDIR /app

# Node deps
COPY package*.json ./
RUN npm ci --omit=dev

# Python deps
COPY requirements.txt ./
RUN pip3 install --no-cache-dir -r requirements.txt --break-system-packages

# Source
COPY . .

RUN mkdir -p uploads rags

EXPOSE 3000

CMD ["node", "server.js"]
