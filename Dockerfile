# Folosim o versiune stabilă și rapidă de Node.js
FROM node:18-alpine

# Setăm directorul de lucru în interiorul containerului
WORKDIR /usr/src/app

# Copiem fișierele de configurare pentru pachete
COPY package*.json ./

# Instalăm dependențele (cors, express, mongoose, etc.)
RUN npm install

# Copiem restul codului sursă în container
COPY . .

# Expunem portul definit în server.js
EXPOSE 3000

# Comanda care pornește serverul
CMD ["npm", "start"]