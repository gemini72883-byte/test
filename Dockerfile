FROM python:3.12-slim

RUN apt-get update && apt-get install -y \
    gcc g++ patchelf ccache zip unzip curl ca-certificates \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

RUN npm -v
RUN node -v

RUN pip install nuitka ordered-set zstandard

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

CMD ["npm", "start"]
