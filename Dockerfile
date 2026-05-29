FROM python:3.12-slim

RUN apt-get update && apt-get install -y \
    gcc g++ patchelf ccache zip unzip \
    && rm -rf /var/lib/apt/lists/*

RUN pip install nuitka ordered-set zstandard

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .

CMD ["npm", "start"]
