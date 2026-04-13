import path from 'node:path';
import {
  exitWithError,
  splitCommaSeparated,
  writeJson,
  writeText,
} from '../helpers.js';
import { executeRetrieval } from '../../application/retrieval/executeRetrieval.js';
import type { RetrievalOutput } from '../../application/retrieval/retrievalTypes.js';
import { resolveBaseDir } from '../../runtimePaths.js';
import type { CommandRegistrar } from '../types.js';

export interface SearchJsonPayload {
  tool: 'codebase-retrieval';
  repo_path: string;
  information_request: string;
  technical_terms: string[];
  content: Array<{ type: 'text'; text: string }>;
  text: string;
  data?: RetrievalOutput['data'];
}

/** 向后兼容：测试和其他模块可能引用 */
export function buildSearchJsonPayload(input: {
  repoPath: string;
  informationRequest: string;
  technicalTerms: string[];
  response: { content: Array<{ type: 'text'; text: string }> };
}): SearchJsonPayload {
  const { repoPath, informationRequest, technicalTerms, response } = input;
  const text = response.content.map((c) => c.text).join('');

  return {
    tool: 'codebase-retrieval',
    repo_path: repoPath,
    information_request: informationRequest,
    technical_terms: technicalTerms,
    content: response.content,
    text,
  };
}

export function registerSearchCommands(cli: CommandRegistrar): void {
  cli
    .command('search', '本地检索（参数对齐 MCP）')
    .option('--repo-path <path>', '代码库根目录（默认当前目录）')
    .option('--information-request <text>', '自然语言问题描述（必填）')
    .option('--technical-terms <terms>', '精确术语（逗号分隔）')
    .option('--json', '以 JSON 输出检索结果')
    .action(
      async (options: {
        repoPath?: string;
        informationRequest?: string;
        technicalTerms?: string;
        json?: boolean;
      }) => {
        const repoPath = options.repoPath ? path.resolve(options.repoPath) : process.cwd();
        const informationRequest = options.informationRequest;
        if (!informationRequest) {
          exitWithError('缺少 --information-request');
        }

        const technicalTerms = splitCommaSeparated(options.technicalTerms);

        const result = await executeRetrieval({
          repoPath,
          informationRequest,
          technicalTerms: technicalTerms.length > 0 ? technicalTerms : undefined,
        });

        if (options.json) {
          writeJson({
            tool: 'codebase-retrieval',
            repo_path: repoPath,
            information_request: informationRequest,
            technical_terms: technicalTerms,
            text: result.text,
            ...(result.data || {}),
          });
          return;
        }

        writeText(result.text);
      },
    );

  cli
    .command('monitor:retrieval', '分析 retrieval 执行效果并给出优化建议')
    .option('--file <path>', '指定日志文件路径')
    .option('--dir <path>', '指定日志目录路径')
    .option('--days <n>', '分析最近 N 天日志', { default: 1 })
    .option('--project-id <id>', '按项目 ID 前缀过滤')
    .option('--request-id <id>', '按 requestId 精确过滤')
    .option('--json', '以 JSON 输出报告')
    .action(
      async (options: {
        file?: string;
        dir?: string;
        days?: string | number;
        projectId?: string;
        requestId?: string;
        json?: boolean;
      }) => {
        const {
          analyzeRetrievalLogDirectory,
          analyzeRetrievalLogFile,
          formatRetrievalMonitorReport,
          resolveDefaultRetrievalLogFile,
        } = await import('../../monitoring/retrievalMonitor.js');

        try {
          const days = Number.parseInt(String(options.days ?? '1'), 10);
          const report =
            options.dir || options.projectId || options.requestId || days > 1
              ? analyzeRetrievalLogDirectory({
                  dirPath: options.dir
                    ? path.resolve(options.dir)
                    : path.join(resolveBaseDir(), 'logs'),
                  days: Number.isFinite(days) && days > 0 ? days : 1,
                  projectId: options.projectId,
                  requestId: options.requestId,
                })
              : analyzeRetrievalLogFile(
                  options.file ? path.resolve(options.file) : resolveDefaultRetrievalLogFile(),
                );

          if (options.json) {
            writeJson(report);
            return;
          }

          writeText(formatRetrievalMonitorReport(report));
        } catch (err) {
          const error = err as Error;
          exitWithError('生成 retrieval 监控报告失败', { error: error.message });
        }
      },
    );
}
