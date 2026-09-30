FROM node:20-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages ./packages
COPY tools ./tools
COPY examples ./examples
COPY tsconfig.json ./
RUN pnpm install --frozen-lockfile && pnpm build

FROM node:20-alpine
WORKDIR /app
RUN apk add --no-cache openssl
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/dist ./dist
COPY package.json ./
USER node
EXPOSE 58991
CMD ["node", "dist/cli.js", "--port", "58991"]
