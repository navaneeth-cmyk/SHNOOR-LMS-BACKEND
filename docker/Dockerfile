FROM node:20-bullseye

# Install system dependencies for code execution
# - Build essentials (gcc, g++, make)
# - Python3 for Python code execution
# - Java (OpenJDK 17) for Java code execution
# - Go for Go code execution
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      build-essential \
      gcc \
      g++ \
      gdb \
      make \
      python3 \
      python3-dev \
      python3-pip \
      openjdk-17-jdk \
      golang-go \
      git \
      curl \
      wget && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Set up Java environment
ENV JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64
ENV PATH="$JAVA_HOME/bin:$PATH"

# Set up Go environment
ENV GOPATH=/go
ENV PATH="$PATH:$GOPATH/bin"

WORKDIR /app

# Install backend dependencies first (better Docker caching)
COPY package*.json ./
RUN npm install

# Copy entire backend source
COPY . .

# Create necessary directories
RUN mkdir -p ./tmp ./uploads && \
    chmod -R 777 ./tmp ./uploads

# Expose API port
EXPOSE 5000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=40s --retries=3 \
  CMD curl -f http://localhost:5000/ || exit 1

# Start the server in development mode by default
CMD ["npm", "run", "dev"]