FROM node:22-alpine
WORKDIR /app
# postgresql-client provides pg_dump/pg_restore for the Backup & DR module
# (matches the PostgreSQL 17 server). curl/wget are used by the healthcheck.
RUN apk add --no-cache postgresql17-client
COPY package*.json ./
RUN npm ci
COPY nest-cli.json tsconfig*.json ./
COPY src ./src
RUN npm run build
EXPOSE 3000
CMD ["npm", "run", "start"]
