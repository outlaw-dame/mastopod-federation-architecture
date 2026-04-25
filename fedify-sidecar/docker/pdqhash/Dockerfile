FROM python:3.11-slim

ARG PDQHASH_REPO=https://github.com/rimu/pdqhash-python.git
ARG PDQHASH_REF=f2b0f7bceda19a94588a7f5a2a4febd88b10a388

ENV PIP_NO_CACHE_DIR=1

RUN apt-get update && apt-get install -y \
    build-essential \
    g++ \
    libffi-dev \
    git \
    && rm -rf /var/lib/apt/lists/*

RUN git clone --recurse-submodules "$PDQHASH_REPO" /app \
    && cd /app \
    && git checkout "$PDQHASH_REF" \
    && git submodule update --init --recursive

WORKDIR /app

RUN pip install -r requirements.txt \
    && pip install -e .

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "7050"]
