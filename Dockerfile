FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY --chown=node:node package.json server.js ./
COPY --chown=node:node public ./public

USER node
EXPOSE 3000

CMD ["npm", "start"]
