# Folosim Node 20 (recomandat de Supabase) pe Alpine
FROM node:20-alpine

# Librării necesare pentru ca pachetul 'sharp' să ruleze perfect pe Alpine
RUN apk add --no-cache vips-dev build-base

WORKDIR /usr/src/app

COPY package*.json ./

RUN npm install

COPY . .

EXPOSE 3000

CMD ["npm", "start"]