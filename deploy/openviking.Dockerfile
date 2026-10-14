FROM ghcr.io/volcengine/openviking:v0.5.0@sha256:c60a83cd79cfce80db5266acb8bdd0908eee8abe8ff559a5f786aa504c251ccf
# Only a bootstrap wrapper; upstream application code stays unchanged.
COPY deploy/openviking-entrypoint.py /stack/openviking-entrypoint.py
RUN chmod 700 /app/.openviking
ENTRYPOINT ["python", "/stack/openviking-entrypoint.py"]
