export function buildDefaultEnvContent(): string {
  return `# ContextAtlas 示例环境变量配置文件

# Embedding API 配置（必需）
EMBEDDINGS_API_KEY=your-api-key-here
EMBEDDINGS_BASE_URL=https://api.siliconflow.cn/v1/embeddings
EMBEDDINGS_MODEL=BAAI/bge-m3
EMBEDDINGS_MAX_CONCURRENCY=10
EMBEDDINGS_BATCH_SIZE=20
EMBEDDINGS_GLOBAL_MIN_INTERVAL_MS=200
EMBEDDINGS_DIMENSIONS=1024

# Reranker 配置（必需）
RERANK_API_KEY=your-api-key-here
RERANK_BASE_URL=https://api.siliconflow.cn/v1/rerank
RERANK_MODEL=BAAI/bge-reranker-v2-m3
RERANK_TOP_N=20

# 索引更新策略（可选）
# 改动比例或估算增量成本达到阈值时，index:update / index:plan 会建议 full rebuild。
INDEX_UPDATE_CHURN_THRESHOLD=0.35
INDEX_UPDATE_COST_RATIO_THRESHOLD=0.65
INDEX_UPDATE_MIN_FILES=8
INDEX_UPDATE_MIN_CHANGED_FILES=5

# Embedding Gateway（可选）
# 使用 contextatlas gateway:embeddings 启动本地 OpenAI-compatible 网关。
# 如果你先接 SiliconFlow，可以直接取消下面这些注释并替换 API Key。
# EMBEDDING_GATEWAY_HOST=127.0.0.1
# EMBEDDING_GATEWAY_PORT=8787
# EMBEDDING_GATEWAY_TIMEOUT_MS=30000
# EMBEDDING_GATEWAY_FAILOVER_COOLDOWN_MS=30000
# EMBEDDING_GATEWAY_CACHE_TTL_MS=60000
# EMBEDDING_GATEWAY_CACHE_MAX_ENTRIES=500
# EMBEDDING_GATEWAY_CACHE_BACKEND=memory
# EMBEDDING_GATEWAY_REDIS_URL=redis://127.0.0.1:6379/0
# EMBEDDING_GATEWAY_REDIS_KEY_PREFIX=contextatlas:gateway:embeddings:
# EMBEDDING_GATEWAY_COALESCE_IDENTICAL_REQUESTS=true
# EMBEDDING_GATEWAY_VALIDATE_UPSTREAMS=true
# EMBEDDING_GATEWAY_VALIDATE_MODELS=BAAI/bge-m3
# EMBEDDING_GATEWAY_VALIDATE_INPUT=dimension-probe
# EMBEDDING_GATEWAY_API_KEYS=local-gateway-token
# EMBEDDING_GATEWAY_UPSTREAMS=[{"name":"siliconflow-primary","baseUrl":"https://api.siliconflow.cn/v1/embeddings","apiKey":"your-api-key-here","weight":1,"models":["BAAI/bge-m3"]}]

# 索引忽略模式（可选，逗号分隔，默认已包含常见忽略项）
# IGNORE_PATTERNS=.venv,node_modules
`;
}
