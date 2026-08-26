# 分类器 thinking 参数黑洞:GLM 系思考模型 灰区系统性 fail-closed 的根因(#7 可选修复项实证)

**结论:扩展传的 `reasoning: "minimal"` 在某内部 provider 插件的网关栈上被折叠为「不发任何思考参数」,GLM 系思考模型 按自身默认档开思考,烧尽 512 maxTokens → 输出空/截断 → fail-closed;重思考拉长时延 → 15s 超时 aborted。**

## 现象(本会话 5 次活体样本)

| 时间(本地) | stopReason | 原始输出 | 对应 Langfuse 观测 |
|---|---|---|---|
| 12:53:32 | length | `""` | (id 略) |
| 12:53:53 | length | `""` | (id 略) |
| 12:54:16 | length | `""` | (id 略) |
| ~14:4x | length | `"<verdict>allow"`(截断) | (另一会话样本) |
| ~14:4x | aborted | `""` | (15s 超时) |

## 源码层(内部 provider 插件@0.9.0,名称不公开)

插件**不碰请求体**(只做 OAuth/header 注入/成本追踪/模型清单),但给所有推理模型(正则匹配 `glm-` 等)统一附加模型元数据:

```js
A = { thinkingLevelMap: { max: "max" }, compat: { forceAdaptiveThinking: true } }
```

- `forceAdaptiveThinking` → pi 核心对 anthropic-messages 改发 adaptive thinking(预算式 thinking 字段被放弃)
- `thinkingLevelMap` 只有 `max` 一个键:按 pi 文档,**omitted 键走默认映射**;`minimal` 在 adaptive 栈上无有效映射 → **整个思考字段被省略**

## 数据层(Langfuse 实证,2026-08-26)

同实例同模型(GLM 系思考模型)三类调用的 `modelParameters` 对比:

| 调用类型 | max_tokens | thinking 字段 |
|---|---|---|
| **auto-mode 分类器**(3 条,时间与 fail-closed 分秒吻合,input 含 `<transcript>…<verdict>` 契约,output 空串) | 512 | **缺失(不发)** |
| 会话级对话(扩展外) | 64000/131072 | `{"type":"adaptive"}` |
| 显式关思考的调用 | 64/8192 | `{"type":"disabled"}` |

→ pi **有能力**发 `thinking: disabled`,但需要正确的 level;`minimal` 在此栈上既不映射为 disabled 也不映射为 effort,直接蒸发。

注:LiteLLM 上报丢弃 system 参数(分类器 system prompt 不在 Langfuse input 里,与 #4 调研一致),识别调用需靠 user message 特征(`<transcript>` + `<verdict>` 契约 + max_tokens 512 + temperature 0)。

## 因果链

```
扩展 reasoning:"minimal"
  → pi 核心: adaptive 栈 + map{max} 无 minimal 映射 → 思考字段省略
  → LiteLLM 网关原样转发(GLM 系思考模型 默认开思考)
  → 按默认高档推理 → 512 maxTokens 全烧(空输出/截断)或超 15s(超时)
  → fail-closed deny → 灰区系统性拦截
```

「插件覆盖思考级别」的假设:**效果上成立,机制上不成立**——不是运行时覆盖,而是插件模型元数据使 minimal 折叠为省略参数,与 GLM 默认开思考两头合谋。

## 兼容性:`reasoning: "off"` 是否通用?(BigModel 官方映射表 + 实证)

BigModel 官方文档(GLM Coding Plan 模型切换指南)的 effort 处理表:

| 工具传入值 | GLM 实际档位 | 处理 |
|---|---|---|
| thinking.type 未传/true/enabled/adaptive | **max** | 使用默认档(本次事故根因:省略参数 = max) |
| thinking.type 为 false/disabled/none/off | **low** | 继续请求;仍会轻量思考 |
| reasoning_effort 为 minimal/light/low | low | 自动转换 |
| reasoning_effort 为 medium/high | high | 自动转换 |
| reasoning_effort 为 xhigh/max/ultra | max | 自动转换 |
| 优先级 | 显式 Effort > thinking 开关 > 默认 max | |

结论:`off` 是**通用请求**而非**通用保证**:

| 模型/栈 | `off` 的实际效果 | 证据 |
|---|---|---|
| 真实 Anthropic | 完全关思考 | pi 标准 anthropic 行为 |
| GLM/BigModel(经内部网关实证) | 降到 effort low,无法归零 | 官方表 + 实测 |
| 无思考能力的模型(reasoning:false) | 无参数可发,no-op | pi 模型元数据 |
| 无法关思考且拒收 disabled 的模型 | 可能报错 → fail-closed | 理论风险,需兜底 |

关键实证:同网关 GLM 系思考模型 上,CC 分类器以 `thinking:{disabled}` + **max_tokens 64** 运行,输出 `<block>no` 成功(当日数十条,偶发空输出 ~3.5%)——「effort low 轻思考 + 小预算」在真实流量中成立,512 余量更宽畅。

另一关键推论:除 `off` 外的低档(`minimal`/`low`)在本 provider 栈上同样面临「map 无键 → 省略参数 → GLM max」黑洞;`off` 是唯一有专用线上形态(`thinking:{type:disabled}`)且已在本网关验证送达的档位。

## 修复建议(兼容性修正版)

1. **扩展侧主修**:`reasoning: "off"` 替代 `"minimal"`——唯一有专用线上形态的档位;GLM 上降为 effort low 轻思考(64 tokens 实证够用,512 余量充足)。
2. **防御兜底(必须保留,非可选)**:契约失败/空输出时重试一次并提高 maxTokens(如 1024)——覆盖「无视 disabled 的模型」与「无法关思考拒收参数的模型」两类长尾,这是模型无关的真正兼容层。
3. **maxTokens 维持 512**:CC 在 64 下已验证 low 档可行,512 对其他模型的轻思考留了余量;重试时提升到 1024。
4. **上游(内部 provider 插件)**:`thinkingLevelMap` 宜补全低档映射(minimal/low → 低档或 disabled),消除「省略参数 = GLM max」陷阱;至少 README 标注。
5. **上游 pi 核心**:per-call reasoning 在 adaptive 栈上折叠为省略参数,对「默认档=max」的模型不安全,值得提报讨论。

## 终版根因修正(第三层,决定性):`reasoning` 从未离开过扩展

前两轮分析(thinkingLevelMap 折叠、off 映射)是**错误层级**的推理——那是对 simple 层(`streamSimple`)行为的正确刻画,但扩展的调用根本没走到那里:

1. 扩展调用 `ctx.modelRegistry.complete()` —— **API 层**方法,选项类型 `ModelsApiStreamOptions<TApi> = AnthropicOptions & ...`;
2. `AnthropicOptions` 的思考字段是 `thinkingEnabled/thinkingBudgetTokens/effort/thinkingDisplay`,**没有 `reasoning`**(后者属于 `SimpleStreamOptions`,由 `streamSimple` 映射;扩展侧 `ModelRegistry` 不暴露 `completeSimple`);
3. TS 为何放行:扩展持有宽类型 `Model<Api>`,条件类型 `ApiStreamOptions<Api>` 落入兜底分支 `StreamOptions & Record<string, unknown>`,**索引签名吞掉了未知属性检查**;
4. 运行时序化:`if (options?.reasoning)` 恒 false,`thinkingEnabled === false` 也未设置 → **任何思考参数都不发** → GLM 默认 max 档(与 BigModel 表第一行吻合)。

**中途实验的教训**:`reasoning: "off"` 修复部署后 Langfuse 实测仍无 thinking 字段——正是这个实验暴露了真正根因。(另注:simple 层若真收到字符串 "off",`!options?.reasoning` 为 false → forceAdaptive 分支 → `mapThinkingLevelToEffort` switch default → **effort "high"**,字符串 "off" 在该层也≠关思考;等价关思考的是省略 reasoning。)

**终版修复**:`thinkingEnabled: false`(anthropic-messages 原生字段,序列化条件 `thinkingLevelMap?.off !== null` 对内部插件的 `{max:"max"}` map 成立)→ 实测送达 `thinking:{"type":"disabled"}`;其他 API 为无害多余属性,由防御重试(512→1024)兜底。

## 复现/验证方法

- 查询:`GET /api/public/v2/observations?type=GENERATION&fromStartTime=…&fields=core,model,io`,按 `modelParameters.max_tokens==512 && temperature==0` + input 含 `<verdict>` 契约识别分类器调用
- 判据:分类器调用的 modelParameters 缺 thinking 字段;output content 空串;对照 64000/131072(adaptive)与 64/8192(disabled)
