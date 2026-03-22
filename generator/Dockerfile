FROM python:3.11-slim

WORKDIR /app

# Install dependencies first (layer cached unless requirements change)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application source
COPY . .

ENV PORT=8001
EXPOSE 8001

CMD ["uvicorn", "api.server:app", "--host", "0.0.0.0", "--port", "8001"]
