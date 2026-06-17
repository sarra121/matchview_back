# --- MatchView backend container image ---

# Start from an official Node.js image. "22" matches our local Node major
# version; "-slim" is a smaller variant (less disk, faster to start).
FROM node:22-slim

# All commands below run inside this folder in the container.
WORKDIR /app

# Copy ONLY the dependency manifests first. Docker caches each build step
# ("layer"); as long as these two files don't change, it reuses the
# installed-dependencies layer on rebuilds instead of reinstalling every time.
COPY package.json package-lock.json ./

# Install exactly the versions pinned in package-lock.json. Includes tsx, which
# runs our TypeScript directly — so there is no separate build step.
RUN npm ci

# Now copy the rest of the source code in.
COPY . .

# The server listens on 8787. EXPOSE documents that; the real port mapping
# happens in `docker run -p`.
EXPOSE 8787

# What runs when the container starts. `start:docker` is `tsx src/server.ts`
# with NO --env-file, because Docker injects the env vars for us at run time.
CMD ["npm", "run", "start:docker"]
