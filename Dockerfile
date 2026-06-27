FROM rust:1.88-bookworm AS builder
WORKDIR /app
COPY Cargo.toml Cargo.lock* ./
COPY src ./src
COPY static ./static
RUN cargo build --release

FROM debian:bookworm-slim
RUN useradd --system --create-home reader
WORKDIR /app
COPY --from=builder /app/target/release/rust-reader /usr/local/bin/rust-reader
RUN mkdir /app/data && chown reader:reader /app/data
USER reader
ENV READER_ADDR=0.0.0.0:3000 READER_DATA_DIR=/app/data
EXPOSE 3000
VOLUME ["/app/data"]
CMD ["rust-reader"]

