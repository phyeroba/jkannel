FROM golang:1.24-alpine AS build
WORKDIR /src
COPY main.go .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/kamex-validator ./main.go

FROM ghcr.io/vaska94/kamex:1.8.3@sha256:c13f0e390bf0cbadef55440a6dc584670851faf41e42a027644e984502a21d7d
USER 0
COPY --from=build /out/kamex-validator /usr/local/bin/kamex-validator
RUN chmod 0555 /usr/local/bin/kamex-validator
USER kamex
ENTRYPOINT ["/usr/local/bin/kamex-validator"]
