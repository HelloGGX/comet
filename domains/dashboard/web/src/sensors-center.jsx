import React from 'react';
import {
  Alert,
  App as AntApp,
  Button,
  Card,
  Col,
  Collapse,
  Descriptions,
  Empty,
  Row,
  Space,
  Statistic,
  Table,
  Tag,
} from 'antd';
import { ReloadOutlined } from '@ant-design/icons';

const runnerStatus = {
  success: { color: 'success', label: '检查通过' },
  failure: { color: 'error', label: '检查失败' },
  below_threshold: { color: 'warning', label: '未达到阈值' },
  pending: { color: 'default', label: '等待检查' },
  disabled: { color: 'default', label: '已停用' },
  on_check: { color: 'processing', label: '按需检查' },
};
const severityLabels = {
  error: { color: 'error', label: '错误' },
  warning: { color: 'warning', label: '警告' },
  info: { color: 'default', label: '信息' },
};
const textStyle = { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', margin: 0 };
const metricColumns = [
  { title: '指标', dataIndex: 'label', render: (label, metric) => label || metric.key },
  { title: '数值', dataIndex: 'value', render: (value, metric) => `${value}${metric.unit || ''}` },
  {
    title: '方向',
    dataIndex: 'direction',
    render: (direction) => (direction === 'less' ? '越小越好' : '越大越好'),
  },
  { title: '阈值', dataIndex: 'threshold', render: (value) => value ?? '—' },
];
const findingColumns = [
  {
    title: '级别',
    dataIndex: 'severity',
    width: 90,
    render: (severity) => {
      const status = severityLabels[severity] ?? severityLabels.info;
      return <Tag color={status.color}>{status.label}</Tag>;
    },
  },
  {
    title: '问题',
    dataIndex: 'message',
    width: 300,
    render: (message) => <span style={textStyle}>{message}</span>,
  },
  {
    title: '位置',
    dataIndex: 'file',
    width: 240,
    render: (file, finding) => (
      <span style={textStyle}>
        {file ?? '—'}
        {finding.line != null ? `:${finding.line}` : ''}
        {finding.column != null ? `:${finding.column}` : ''}
      </span>
    ),
  },
  { title: '规则', dataIndex: 'rule', width: 160, render: (rule) => rule ?? '—' },
];

function timestamp(value) {
  if (!value) return '尚无记录';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN');
}

function SensorsRunner({ name, runner, previous }) {
  const status = runnerStatus[runner.status] ?? runnerStatus.pending;
  const reading = runner.reading;
  const score = reading?.score;
  const previousScore = previous?.reading?.score;
  const scoreChange =
    score && previousScore ? Number((score.value - previousScore.value).toFixed(4)) : null;
  const trend =
    scoreChange == null || score.direction !== previousScore.direction
      ? null
      : scoreChange === 0
        ? '持平'
        : (score.direction === 'less' ? scoreChange < 0 : scoreChange > 0)
          ? '改善'
          : '恶化';
  const reportItems = [
    reading?.formatted?.summary_llm && {
      key: 'summary',
      label: '检测报告',
      children: <pre style={textStyle}>{reading.formatted.summary_llm}</pre>,
    },
    reading?.formatted?.failures_llm && {
      key: 'failures',
      label: '失败详情',
      children: <pre style={textStyle}>{reading.formatted.failures_llm}</pre>,
    },
    ...(reading?.guidance ?? []).map((guidance, index) => ({
      key: `guidance-${index}`,
      label: guidance.rule,
      children: <pre style={textStyle}>{guidance.body}</pre>,
    })),
  ].filter(Boolean);
  return (
    <Card
      size="small"
      title={<span style={textStyle}>{name}</span>}
      extra={<Tag color={status.color}>{status.label}</Tag>}
    >
      <Space orientation="vertical" size="middle" style={{ width: '100%', minWidth: 0 }}>
        <Row gutter={[16, 16]}>
          {score && (
            <Col xs={24} sm={8}>
              <Statistic title="评分" value={score.value} />
              <div className="mt-1 text-xs text-muted" style={textStyle}>
                {score.description}
                {score.threshold != null ? ` · 阈值 ${score.threshold}` : ''}
                {` · ${score.direction === 'less' ? '越小越好' : '越大越好'}`}
              </div>
              {scoreChange != null && (
                <div className="mt-1 text-xs text-muted">
                  上次快照 {previousScore.value} · 变化 {scoreChange > 0 ? '+' : ''}
                  {scoreChange}
                  {trend ? ` · ${trend}` : ''}
                </div>
              )}
            </Col>
          )}
          <Col xs={24} sm={score ? 16 : 24}>
            <Descriptions
              size="small"
              column={1}
              items={[
                { key: 'mode', label: '运行模式', children: runner.mode },
                { key: 'lastRun', label: '上次检查', children: timestamp(runner.lastRun) },
              ]}
            />
          </Col>
        </Row>
        {!reading ? (
          <p className="text-sm text-muted" style={{ margin: 0 }}>
            {runner.status === 'disabled'
              ? '此检测器已停用。请在 Sensors 配置中启用它，再运行 sensors start .。'
              : runner.status === 'on_check'
                ? '此检测器按需运行。请在项目目录运行 sensors check .，再刷新此页面。'
                : '尚未生成检测结果。请在项目目录运行 sensors start .，使用 sensors show . 查看结果。'}
          </p>
        ) : (
          <>
            {reading.success === false ? (
              <Alert type="error" showIcon title="检测未通过" description={reading.summary} />
            ) : (
              <p style={textStyle}>{reading.summary}</p>
            )}
            {reading.metrics.length > 0 && (
              <section aria-label={`${name} 检测指标`} style={{ minWidth: 0 }}>
                <Table
                  size="small"
                  columns={metricColumns}
                  dataSource={reading.metrics}
                  rowKey={(metric, index) => `${metric.key}-${index}`}
                  pagination={false}
                  scroll={{ x: 480 }}
                />
              </section>
            )}
            <section aria-label={`${name} 检测问题`} style={{ minWidth: 0 }}>
              <Table
                size="small"
                columns={findingColumns}
                dataSource={reading.findings}
                rowKey={(_, index) => String(index)}
                pagination={false}
                scroll={{ x: 790, y: 360 }}
                locale={{ emptyText: '没有检测问题' }}
                expandable={{
                  rowExpandable: (finding) => Boolean(finding.context),
                  expandedRowRender: (finding) => <pre style={textStyle}>{finding.context}</pre>,
                }}
              />
            </section>
            {reportItems.length > 0 && <Collapse size="small" items={reportItems} />}
          </>
        )}
      </Space>
    </Card>
  );
}

export function SensorsCenter({ data, refreshing, onRefresh, readOnly = false, onInvoke }) {
  const { modal } = AntApp.useApp();
  const sources = data?.sources ?? [];
  const errors = data?.errors ?? [];
  return (
    <section
      className="mx-auto max-w-dashboard pb-6"
      aria-label="Sensors 静态检测"
      style={{ minWidth: 0 }}
    >
      <div className="mb-4 mt-2 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="dashboard-section-heading text-[20px] font-semibold leading-[1.3]">
            Sensors
          </h2>
          <p className="mt-1 text-sm text-muted">sensors show · 当前项目的静态检测结果</p>
        </div>
        <Space wrap>
          <Button icon={<ReloadOutlined />} loading={refreshing} onClick={onRefresh}>
            刷新 Sensors
          </Button>
          <Button disabled={readOnly} onClick={() => onInvoke('lifecycle', { action: 'disable' })}>
            停用插件
          </Button>
          <Button
            danger
            disabled={readOnly}
            onClick={() =>
              modal.confirm({
                title: '卸载 Sensors 插件？',
                content: '卸载只停止 Comet 插件，Sensors 配置和检测结果会保留。',
                okText: '卸载',
                cancelText: '取消',
                onOk: () => onInvoke('lifecycle', { action: 'uninstall' }),
              })
            }
          >
            卸载插件
          </Button>
        </Space>
      </div>
      <Space orientation="vertical" size="middle" style={{ width: '100%', minWidth: 0 }}>
        {errors.length > 0 && (
          <Alert
            type="error"
            showIcon
            title="Sensors 数据读取失败"
            description={errors.map((error, index) => (
              <p key={index} style={textStyle}>
                {error}
              </p>
            ))}
          />
        )}
        {sources.length === 0 ? (
          <Card size="small">
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description="当前项目还没有 Sensors 检测结果"
            >
              <p className="text-sm text-muted">
                配置 Sensors 后，在项目目录运行 <code>sensors start .</code>。
              </p>
              <p className="text-sm text-muted">
                使用 <code>sensors show .</code> 查看结果，再刷新此页面。
              </p>
            </Empty>
          </Card>
        ) : (
          sources.map((source) => (
            <section
              key={source.stateFile}
              aria-label={`Sensors 来源 ${source.configFile ?? source.stateFile}`}
              style={{ minWidth: 0 }}
            >
              <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
                <strong style={textStyle}>{source.configFile ?? source.stateFile}</strong>
                <span>更新时间：{timestamp(source.state?.lastUpdated)}</span>
                {source.state?.snapshot && (
                  <span>对比快照：{timestamp(source.state.snapshot.timestamp)}</span>
                )}
              </div>
              <Space orientation="vertical" size="middle" style={{ width: '100%', minWidth: 0 }}>
                {source.status === 'error' && (
                  <Alert
                    type="error"
                    showIcon
                    title="状态文件无法读取"
                    description={source.error}
                  />
                )}
                {source.status === 'missing' && (
                  <Alert
                    type="info"
                    showIcon
                    title="尚未生成状态文件"
                    description="在项目目录运行 sensors start .，再使用 sensors show . 查看检测结果。"
                  />
                )}
                {Object.entries(source.state?.runners ?? {}).map(([name, runner]) => (
                  <SensorsRunner
                    key={name}
                    name={name}
                    runner={runner}
                    previous={source.state?.snapshot?.runners?.[name]}
                  />
                ))}
              </Space>
            </section>
          ))
        )}
      </Space>
    </section>
  );
}
