# Offline / air-gapped Docker install

The platform targets environments where public container registries may be
unreachable (sanctions / network restrictions — see ops-envelope §9). All images
in `docker-compose.yml` are pinned by `sha256` digest so a bundle built on a
connected machine loads byte-identical on the air-gapped target.

## 1. On a connected machine — save the images

Pull the digest-pinned images and export them to a single tarball:

```bash
# App image (built locally from Dockerfile.dev / Dockerfile).
docker compose build

# Pull the pinned third-party images referenced in docker-compose.yml.
docker compose pull postgres redis minio

# Save everything to a portable archive.
docker save \
  postgres@sha256:57c72fd2a128e416c7fcc499958864df5301e940bca0a56f58fddf30ffc07777 \
  redis@sha256:6ab0b6e7381779332f97b8ca76193e45b0756f38d4c0dcda72dbb3c32061ab99 \
  minio/minio@sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e \
  -o analytics-images.tar
```

Copy `analytics-images.tar` (and the app image, if built separately) to the
air-gapped host via approved transfer media.

## 2. On the air-gapped host — load the images

```bash
docker load -i analytics-images.tar
docker compose up -d
```

Because the compose file references images by digest, Docker uses the loaded
layers directly and never contacts a registry.

## 3. Refreshing pins

When a base image must be updated, re-resolve the digest on a connected machine:

```bash
docker pull postgres:16-alpine
docker inspect --format '{{index .RepoDigests 0}}' postgres:16-alpine
```

Replace the digest in `docker-compose.yml` and this file, then rebuild the
bundle. Never switch a service back to a floating tag — the digest pin is the
reproducibility and supply-chain guarantee.
