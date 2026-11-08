---
layout: post
title: "LLM 모델 라우팅을 설계하는 법: 품질·지연·비용·Fallback을 함께 결정하기"
categories: [AI]
tags: [ai, llm, model-routing, fallback, evaluation, cost]
description: "LLM 모델 라우팅의 기본 개념부터 작업 분류·품질 평가·fallback·비용 상한·관찰 기준을 설명하고, 하나의 모델만 고르는 방식의 한계를 정리합니다."
---

## 먼저 답하기

### Q. 더 성능이 좋은 모델 하나만 모든 요청에 쓰면 되지 않나요?

A. 단순한 운영에는 좋은 선택일 수 있지만, 모든 요청의 위험·난이도·응답 시간·비용이 같지는 않습니다. 짧은 문서 분류, 검색어 정규화, 구조화된 추출은 작은 모델로 충분할 수 있고, 복잡한 다단계 분석이나 고위험 고객 답변은 더 강한 모델과 추가 검증이 필요할 수 있습니다. 모델 라우팅은 무조건 싼 모델을 먼저 쓰는 기법이 아니라, 요청의 목적과 실패 비용에 맞는 경로를 명시적으로 선택하는 설계입니다.

### Q. fallback을 넣으면 장애가 나도 답변 품질이 항상 유지되나요?

A. 아닙니다. fallback 모델은 다른 출력 형식, 도구 호출 능력, context window, 안전 정책, rate limit을 가질 수 있습니다. primary가 실패했을 때 무작정 다른 모델에 같은 prompt를 보내면 JSON 계약이 깨지거나 권한 없는 도구가 실행되거나, 사용자에게 서로 다른 답을 줄 수 있습니다. fallback은 사전에 평가한 호환 가능한 작업에만 적용하고, 응답을 생성하지 못하면 안전하게 재시도·보류·사람 이관으로 끝내는 경로도 포함해야 합니다.

## 먼저 알아둘 기반 기술

### 모델 호출은 하나의 기능이 아니다

LLM(Large Language Model, 대규모 언어 모델)을 제품에 연결할 때 한 API endpoint만 호출해도, 실제 요청은 서로 다른 목적을 가질 수 있습니다. 고객 문의를 분류하는 작업, 문서에서 날짜와 금액을 JSON으로 추출하는 작업, RAG(Retrieval-Augmented Generation, 검색 증강 생성) 근거를 요약하는 작업, 코드 초안을 만드는 작업, tool call을 계획하는 작업은 필요한 정확도와 허용 가능한 오류가 다릅니다. 같은 token 수라도 한 작업의 실수는 오탈자에 그치고, 다른 작업은 금전·권한·계약 판단에 영향을 줄 수 있습니다.

모델 라우팅(model routing)은 request의 속성과 정책을 바탕으로 모델·prompt·도구·retrieval 깊이·출력 검증을 고르는 과정입니다. 속성에는 사용자 선택, 기능 종류, 입력 길이, 언어, 민감도, latency 목표, 예상 비용, 현재 provider 상태가 들어갈 수 있습니다. 중요한 것은 라우터가 모델 이름을 숨기는 마법 상자가 아니라, 제품의 품질·비용·안전 결정을 코드와 운영 규칙으로 드러내는 위치라는 점입니다.

### 품질, 지연, 비용의 관계

일반적으로 더 큰 모델이나 더 긴 reasoning 설정은 어려운 작업에서 좋은 결과를 줄 가능성이 있지만, 호출 비용과 응답 시간이 늘 수 있습니다. 반대로 작은 모델은 단순 작업을 빠르게 처리할 수 있지만 모호한 지시, 긴 문맥, 드문 도메인 용어에서 더 자주 실수할 수 있습니다. 이 관계는 모델 설명만 보고 결정할 수 없습니다. 실제 제품의 질문, 출력 형식, 언어, retrieval 결과, 안전 규칙으로 평가해야 합니다.

비용은 요청당 가격만이 아닙니다. prompt와 context의 input token, 생성된 output token, 재시도, fallback, reranker·retrieval 호출, 사용자 재질문, 잘못된 답으로 생기는 지원 비용을 함께 봐야 합니다. latency도 모델 응답 시간만이 아니라 queue, network, tool 실행, retrieval, validation, streaming UI까지 포함합니다. 라우팅은 모델 비용을 줄이려다 사용자가 여러 번 다시 묻는 비용을 키우지 않게 균형을 잡는 일입니다.

### 평가셋과 정책의 역할

모델을 고르는 기준은 인상적인 demo가 아니라 대표 작업의 평가 결과여야 합니다. 평가셋에는 정상 요청뿐 아니라 모호한 질문, 긴 입력, 한국어·영어 혼합, 구조화 출력 오류, 검색 근거 부족, 민감 정보, 도구 실패, 답변을 보류해야 하는 사례를 넣습니다. 각 사례에 정답 또는 허용 기준, 위험 등급, 필요한 출력 schema, 금지 행동을 기록하면 모델별 차이를 비교할 수 있습니다.

정책(policy)은 평가 결과를 운영 결정으로 바꿉니다. 예를 들어 공개 FAQ 요약은 빠른 모델을 기본으로 하되, confidence가 낮거나 검색 근거가 부족하면 더 큰 모델로 보내지 않고 출처 부족 안내를 할 수 있습니다. 반면 계약 검토 초안은 강한 모델을 쓰더라도 법률 판단을 자동화하지 않고 검토자에게 넘길 수 있습니다. 어떤 경로를 선택하든, 책임을 모델 점수 하나에 넘기지 않는 기준이 필요합니다.

## 라우팅 규칙을 만드는 순서

### 1. 기능을 위험과 출력 계약으로 나누기

먼저 제품 기능을 "채팅"처럼 넓게 묶지 말고, 입력·출력·실패 영향이 같은 작업 단위로 나눕니다. 예를 들어 배송 문의 분류는 정해진 category enum을 반환하는 작업이고, 고객 답변 초안은 자연어와 인용을 만드는 작업이며, 환불 요청의 실제 실행은 외부 tool과 권한 검사가 필요한 작업입니다. 세 작업에 같은 모델·prompt·fallback 규칙을 쓰면 어느 경로가 위험한지 알기 어렵습니다.

출력 계약도 명확히 합니다. 분류 결과가 `shipping`, `refund`, `account` 중 하나여야 한다면 JSON schema와 허용 enum을 검증할 수 있습니다. 자유 텍스트 답변이라도 인용 링크가 필요하다, 금액을 단정하면 안 된다, 근거가 없으면 보류해야 한다처럼 정책을 표현할 수 있습니다. 모델 라우터는 이 계약을 기준으로 선택하고, 호출 뒤 validator가 계약을 확인하게 해야 합니다.

### 2. 단순 경로와 고위험 경로를 분리하기

입력이 짧고 결과가 제한된 작업은 작은 모델 또는 규칙 기반 처리의 좋은 후보입니다. 예를 들어 문서 제목에서 제품명을 추출하거나, 사용자가 선택한 언어를 판별하거나, 이미 정해진 태그 중 하나로 ticket를 분류하는 일입니다. 이때도 모델 출력이 schema를 지키는지 검사하고, 불명확하면 `unknown`으로 돌려 사람 또는 다음 단계가 처리하게 해야 합니다. 작은 모델이 항상 정답을 낼 것이라 가정해 자동 실행까지 연결하면 안 됩니다.

고위험 경로는 정확도뿐 아니라 근거·권한·감사 기록이 중요합니다. 고객의 계정 상태를 바꾸는 요청, 사내 정책 안내, 결제·법률·의료 관련 내용, 외부 도구를 실행하는 agent 작업은 더 강한 모델을 쓴다고 안전해지지 않습니다. 검색 근거, 승인 단계, deterministic validation, 실행 권한 최소화, 사용자 확인을 함께 설계합니다. 라우팅은 이 경로를 빠른 모델로 내리는 최적화보다, 별도의 보호 규칙을 적용하는 경계가 되어야 합니다.

### 3. 모델 이름보다 capability를 기준으로 선언하기

라우팅 설정에 특정 모델 이름만 직접 흩어 놓으면 provider가 모델을 교체하거나 가격·limit을 바꿀 때 수정 범위가 커집니다. 애플리케이션 내부에서는 `fast-classifier`, `grounded-answer`, `tool-planner`처럼 작업 역할(capability)을 정의하고, 운영 설정에서 그 역할을 어느 승인된 모델과 연결할지 관리할 수 있습니다. 이것은 불필요한 추상화를 만들자는 뜻이 아니라, 모델 교체가 필요할 때 정책·평가·fallback 위치를 한곳에서 검토하게 하는 최소 경계입니다.

capability에는 지원하는 언어, 최대 입력 길이, 구조화 출력·tool calling 지원 여부, 예상 latency, 비용 상한, 평가셋 버전, fallback 후보를 기록할 수 있습니다. 값은 시간이 바뀌므로 정적 문서만 믿지 말고 호출 로그와 정기 평가로 갱신합니다. 특히 모델 alias가 같은 이름으로 다른 version을 가리킬 수 있다면, 중요한 release에서는 실제 model identifier와 평가 시점을 남겨 재현성을 높입니다.

## Fallback은 재시도가 아니라 별도 제품 경로다

primary 모델 호출이 실패하는 이유는 rate limit, timeout, provider 장애, content filter, context 길이 초과, malformed tool call, schema 검증 실패 등 다양합니다. 이 원인마다 같은 fallback이 적합하지 않습니다. network timeout이라면 같은 모델의 짧은 재시도가 도움이 될 수 있지만, context가 너무 길다면 다른 모델로 보내도 실패할 수 있습니다. schema가 틀렸다면 output repair 또는 더 엄격한 structured output 요청을 검토할 수 있고, safety 정책에 걸렸다면 다른 모델로 우회하는 것이 아니라 안전한 안내를 반환해야 합니다.

fallback 모델을 쓸 때는 prompt·output schema·tool policy가 호환되는지 평가합니다. primary가 JSON schema를 강제할 수 있는데 fallback은 자유 텍스트만 만든다면, fallback 결과를 그대로 자동 처리해서는 안 됩니다. fallback이 tool calling을 지원하지 않거나 호출 형식이 다르면, 도구 실행을 끄고 사용자에게 재시도 안내를 하거나 사람이 검토하는 단계로 보내는 편이 안전할 수 있습니다. availability를 높이려다 권한·정합성 경계를 낮추지 않아야 합니다.

다음은 개념을 보여 주는 의사 코드입니다. 실제 provider SDK와 오류 타입은 사용하는 플랫폼에 맞춰야 합니다.

```text
if request.kind == "ticket-classification":
    result = call(fast_classifier)
    return validate_enum_or_unknown(result)

if request.kind == "grounded-policy-answer":
    sources = retrieve_with_permissions(request)
    if sources.is_empty:
        return explain_missing_source()
    result = call(grounded_answer_model, sources)
    return validate_citations_or_hold(result)

if primary_times_out and request.kind == "ticket-classification":
    return call(compatible_fallback_classifier)

return safe_failure_message()
```

여기서 중요한 것은 fallback 조건이 작업별로 좁다는 점입니다. 정책 답변에 필요한 source가 없는데 더 큰 모델로 보내는 것은 품질 개선이 아니라 근거 없는 답변의 위험을 키울 수 있습니다. 반대로 단순 분류가 일시 timeout이면 호환 가능한 fallback으로 가는 것이 사용자 경험을 개선할 수 있습니다. 실패 원인과 작업 위험을 함께 보지 않는 fallback은 장애를 조용히 다른 형태의 결함으로 바꿀 수 있습니다.

## 비용 상한과 context 예산

모델 라우팅에서 예산은 월간 비용 한도를 넘지 않게 하는 숫자만이 아닙니다. request마다 최대 input·output token, retrieval 문서 수, tool 호출 횟수, retry 횟수, reasoning 시간 같은 상한을 두면 prompt injection이나 비정상적으로 긴 입력이 비용과 latency를 증폭하는 일을 줄일 수 있습니다. 상한에 걸렸을 때 품질을 조용히 낮추기보다, 요청을 요약해 달라고 하거나 범위를 좁히거나 비동기 처리로 전환하는 선택을 사용자에게 알려야 합니다.

context를 큰 모델에 모두 넣는 전략도 주의합니다. 관련 없는 문서가 많으면 중요한 근거가 묻히고, 비용과 latency가 커지며, 민감한 문서 노출 범위도 넓어집니다. retrieval에서 권한·최신성·관련성을 먼저 적용하고, 문서당 최대 chunk 수와 중복 제거 규칙을 둡니다. 특정 작업이 긴 context를 꼭 필요로 한다면, 그것을 capability 요구 조건으로 명시하고 해당 경로만 더 큰 context window 모델로 보냅니다.

사용자·tenant·기능별 budget도 고려할 수 있습니다. 한 사용자의 반복 재시도가 전체 provider quota를 소진하지 않게 하고, 내부 실험 기능이 고객 지원 핵심 경로의 latency를 밀어내지 않게 합니다. 그러나 비용 제한이 고위험 요청의 검증을 건너뛰는 이유가 되어서는 안 됩니다. 중요한 작업은 호출 횟수를 줄이는 대신 승인·queue·사람 검토처럼 다른 안전 경로를 설계해야 합니다.

## 관찰 가능성과 평가의 연결

라우터가 어떤 결정을 내렸는지 관찰하지 못하면, 모델을 여러 개 쓰는 복잡도만 늘어납니다. 요청마다 feature 또는 capability, 선택한 model identifier, prompt template version, retrieval 여부와 문서 수, input·output token, latency, retry·fallback 이유, validator 결과, 사용자 피드백을 민감값 없이 기록할 수 있습니다. 이 정보는 특정 모델이 느린지, fallback이 자주 일어나는지, schema 오류가 어느 경로에 몰리는지 분석하게 해 줍니다.

로그에는 원문 prompt, 개인정보, 인증 token, 내부 문서 본문을 무조건 넣지 않습니다. 디버깅에 필요한 request ID, 길이, hash, 오류 종류, model 버전, 허용된 metadata처럼 최소 정보를 선택하고, 상세 내용을 볼 수 있는 권한과 보관 기간을 분리합니다. AI 관찰성은 모든 대화를 저장하는 일이 아니라, 모델 동작과 제품 위험을 연결할 수 있는 신호를 안전하게 남기는 일입니다.

평가셋도 라우터 단위로 실행합니다. primary만 높은 점수를 받아도 routing rule이 복잡한 질문을 작은 모델로 보내거나 fallback이 citation을 잃으면 실제 품질은 낮아질 수 있습니다. 입력 분류, 선택된 경로, output validator, 최종 응답까지 포함한 end-to-end 평가로 각 정책 변경을 비교합니다. 전체 평균 외에 언어·난이도·위험 등급별 결과와 실패 비용이 큰 사례를 별도로 봐야 합니다.

## 업무 예시: 사내 IT 지원 도우미

사내 IT 지원 도우미가 있다고 가정합니다. 사용자가 "VPN이 안 돼요"라고 입력하면 첫 단계는 ticket category와 운영체제를 분류하는 일입니다. 이 결과는 제한된 enum이므로 빠른 모델과 schema validator로 처리할 수 있습니다. `unknown` 또는 confidence 부족이면 분류를 억지로 결정하지 않고 사용자가 OS·오류 메시지를 선택하게 합니다. 잘못된 분류가 바로 계정 변경을 실행하지 않는 구조가 핵심입니다.

다음 단계에서 도우미가 사내 VPN 안내 문서를 검색해 답을 만들 때는, 사용자의 조직과 권한으로 접근 가능한 최신 문서만 retrieval합니다. 근거가 있으면 grounded-answer capability가 인용과 함께 안내를 만들고, 근거가 없으면 "정책 문서를 찾지 못했다"고 말하며 지원 채널을 안내합니다. 모델이 더 강하다는 이유로 없는 VPN 설정 값을 만들어 내도록 하면 안 됩니다.

비밀번호 초기화나 device 등록처럼 상태를 바꾸는 요청은 별도 경로입니다. 모델은 필요한 정보를 정리하거나 사용자의 의도를 확인할 수 있지만, 실제 tool은 identity·권한·사용자 확인·audit log를 통과한 뒤에만 실행합니다. primary tool-planner가 timeout이 났다고 fallback 모델이 더 넓은 권한으로 실행해서는 안 됩니다. 이 예시는 routing이 비용 최적화뿐 아니라 자동화 경계를 나누는 설계라는 점을 보여 줍니다.

## 적용 순서와 흔한 실수

처음부터 여러 모델과 동적 점수 계산을 넣을 필요는 없습니다. 먼저 기능 하나를 골라 현재 단일 모델의 품질·latency·비용·실패 사례를 측정합니다. 그 다음 출력 schema가 뚜렷하고 위험이 낮은 작업 하나에 빠른 모델을 적용하고, 동일 평가셋에서 결과를 비교합니다. validator·fallback·logging이 준비된 뒤에만 더 많은 경로를 추가합니다. 모델 수보다 관찰·검증 가능한 경로 수가 중요합니다.

가장 흔한 실수는 단순한 keyword로 사용자의 난이도를 판단하는 것입니다. "계약"이라는 단어가 있다고 무조건 큰 모델로 보내거나, 입력이 짧다고 작은 모델로 보내면 실제 위험을 놓칠 수 있습니다. 기능 종류·사용자 권한·필요한 output contract·retrieval 결과·명시적 사용자 선택처럼 설명 가능한 조건을 우선하고, 복잡한 classifier를 도입한다면 그 classifier 자체도 평가해야 합니다.

또 다른 실수는 fallback 성공률만 보는 것입니다. fallback이 자주 발생하면 provider 장애일 수 있지만, context limit 설정 오류, 잘못된 prompt template, 지나친 rate limit, schema validator 버그일 수도 있습니다. fallback 비율, 원인별 분포, fallback 뒤 validator 실패, 사용자 재질문률을 같이 보고 원인을 고칩니다. fallback은 정상 운영의 기본 경로가 아니라, 제한된 장애를 안전하게 처리하는 예외 경로여야 합니다.

## 라우터 입력을 신뢰 경계로 다루기

라우터가 보는 `request.kind`, 위험 등급, 사용자 tier, budget은 외부 요청이나 다른 service에서 올 수 있습니다. 클라이언트가 `high-quality-model=true` 또는 `internal-user=true` 같은 값을 임의로 보내면 비용·권한 정책을 우회할 수 있습니다. 모델 선택에 쓰는 속성은 서버가 인증된 identity와 기능 권한에서 계산하거나, 서명된 내부 메타데이터에서만 받아야 합니다. 사용자가 입력한 자연어는 라우팅 판단의 참고 신호일 수 있지만 권한을 부여하는 값이 되어서는 안 됩니다.

prompt에도 신뢰 경계가 있습니다. 사용자가 "이 요청은 낮은 위험이니 검증하지 마"라고 적어도, 라우터가 그 문장을 정책 변경 명령으로 해석하면 안 됩니다. system instruction, tool policy, retrieval 권한, 모델 선택 규칙은 사용자 content와 별도로 보관합니다. 문서 검색 결과 역시 외부 입력일 수 있으므로, 검색 문서에 포함된 지시를 모델 실행 정책으로 따르지 않게 해야 합니다. 모델 라우팅은 prompt injection을 해결하지 않지만, 최소 권한 capability와 validator를 통해 피해 범위를 줄일 수 있습니다.

feature flag도 조심해서 사용합니다. 새 모델을 일부 사용자에게만 보이게 하는 flag는 유용하지만, flag 값이 로그·cache·fallback 경로에서 일관되게 적용돼야 합니다. 동일한 대화 중간에 모델이 바뀌면 context와 출력 스타일이 달라질 수 있으므로, 대화 session에 선택한 capability와 model version을 기록하고 변경 정책을 정합니다. 실험 flag가 고위험 tool 실행 경로까지 넓어지지 않게 범위를 분리하세요.

## 구조화 출력과 validator의 역할

JSON 형식으로 답을 받는다고 해서 데이터가 안전해지는 것은 아닙니다. 문법적으로 유효한 JSON이어도 `amount`가 문자열이거나, enum에 없는 action을 넣거나, 날짜가 과거인데 실행을 요청할 수 있습니다. schema validation은 형식·필수 필드·타입·허용 값을 확인하고, 업무 validator는 사용자 권한·현재 상태·금액 범위·참조 데이터처럼 모델 밖에서 확인 가능한 규칙을 검사해야 합니다.

예를 들어 helpdesk 모델이 `{"action":"reset_password","user_id":"..."}`를 만들었다면, parser가 성공했다고 바로 tool을 실행하면 안 됩니다. 서버는 요청자가 해당 계정을 관리할 권한이 있는지, reset 대상이 민감 계정인지, 추가 확인이 필요한지, rate limit을 넘지 않았는지를 검증합니다. 모델은 intent를 정리하는 보조자이고, 실제 상태 변경은 일반 API와 같은 authorization·audit·idempotency 경계를 통과해야 합니다.

validator 실패도 라우팅 데이터입니다. 특정 model에서만 enum 철자 오류가 많다면 prompt를 더 길게 만드는 것보다 structured output 지원 여부와 모델 suitability를 다시 평가합니다. 모든 실패를 더 큰 모델로 재시도하면 비용은 늘고 원인은 숨겨집니다. 고정된 template, deterministic repair, 사용자에게 선택을 다시 받기, 사람이 검토하기 중 무엇이 해당 작업의 위험에 맞는지 선택하세요.

## Cache와 라우팅의 상호작용

동일한 질문에 대한 response cache나 prompt cache는 비용과 latency를 줄일 수 있지만, 모델 라우팅이 있으면 cache key가 더 중요해집니다. 사용자 질문 문자열만 key로 쓰면 서로 다른 tenant·권한·문서 버전·모델·prompt template의 응답을 잘못 공유할 수 있습니다. cache key에는 최소한 capability, model 또는 응답 정책 version, 권한 경계, retrieval corpus version처럼 결과 의미에 영향을 주는 값을 포함할지 검토해야 합니다.

특히 RAG 답변은 문서가 갱신되면 이전 cache가 오래된 정책을 돌려줄 수 있습니다. TTL을 짧게 두는 것만으로 충분하지 않을 수 있으며, 문서 version이나 관련 source의 변경 이벤트를 이용해 무효화하는 정책이 필요할 수 있습니다. 반대로 모든 cache를 끄면 같은 단순 질문에도 매번 비싼 경로를 타게 됩니다. 어떤 작업이 안전하게 재사용 가능한지, 사용자별 답이어야 하는지, freshness가 얼마나 중요한지 기준으로 cache 범위를 정합니다.

fallback 응답을 primary cache에 섞는 것도 주의합니다. 장애 중 fallback 모델이 만든 답을 cache에 저장하면 primary가 복구된 뒤에도 낮은 품질 또는 다른 정책의 답이 계속 제공될 수 있습니다. 응답 metadata에 생성 경로를 남기고, fallback 결과의 cache TTL과 재검증 정책을 더 보수적으로 둘 수 있습니다. cache는 라우팅을 보이지 않게 만드는 최적화가 아니라, 라우팅 결정의 일부로 설계해야 합니다.

## rollout과 회귀 방지

새 모델이나 라우팅 규칙은 전체 트래픽에 한 번에 적용하지 않는 편이 좋습니다. 먼저 offline evaluation에서 현재 경로와 후보 경로를 같은 평가셋으로 비교하고, 구조화 출력·안전 거절·근거 인용·언어별 품질처럼 절대 떨어지면 안 되는 항목을 확인합니다. 그 다음 내부 사용자 또는 낮은 위험 기능에 제한적으로 적용하고, latency·validator 실패·fallback·사용자 재질문·지원 문의를 관찰합니다.

온라인 실험에서 단순한 thumbs-up 비율만 보지 않습니다. 사용자가 빠르게 좋은 답을 받아서 재질문하지 않은 것인지, 답을 이해하지 못해 이탈한 것인지 구분하기 어렵기 때문입니다. 가능하면 작업 완료율, 사람 이관율, 근거 클릭, schema 오류, tool 실행 취소, 정책 위반 신호를 함께 봅니다. 개인정보나 민감한 내용을 실험 분석을 위해 과도하게 모으지 않도록 metric 설계 단계에서 데이터 최소화 원칙을 적용합니다.

rollback은 model alias를 되돌리는 한 줄이 아닐 수 있습니다. prompt template, retrieval 설정, validator schema, cache key, feature flag, tool policy가 함께 바뀌면 이전 모델만 복구해도 결과가 달라질 수 있습니다. release마다 이 구성의 version을 묶어 기록하고, 문제가 생기면 어떤 조합으로 되돌릴지 정합니다. 고위험 경로는 canary에서 이상을 발견했을 때 자동 tool 실행을 끄고 읽기 전용 안내로 낮추는 안전 모드도 검토할 수 있습니다.

## routing table을 작게 시작하는 예시

처음부터 입력 token 수와 의미 유사도, 사용자 행동을 조합한 복잡한 점수 함수를 만들 필요는 없습니다. 다음처럼 설명 가능한 세 경로로 시작할 수 있습니다.

| 작업 | 기본 경로 | 필수 검증 | 실패 시 행동 |
| --- | --- | --- | --- |
| ticket 분류 | 빠른 분류 모델 | enum·언어·입력 길이 | `unknown`으로 사용자 선택 요청 |
| 문서 기반 안내 | 근거 답변 모델 | 권한 필터·인용·근거 부족 | 답변 보류와 지원 채널 안내 |
| 상태 변경 요청 | 계획 모델 + 일반 API | schema·권한·사용자 확인·audit | 실행하지 않고 사람 이관 또는 재확인 |

이 표의 장점은 정책 검토가 쉽다는 것입니다. 새로운 요청이 생기면 어느 행에 들어가는지, 기존 행이 위험을 충분히 표현하는지 토론할 수 있습니다. 작은 모델을 쓸 수 있다는 이유만으로 상태 변경 요청을 첫 행에 넣지 않고, 사용자가 자연어로 명령했다는 이유만으로 세 번째 행의 검증을 생략하지 않습니다. routing table은 모델 선택표이면서 제품의 자동화 수준을 공개하는 문서입니다.

시간이 지나면 모델별 품질과 비용 데이터에 따라 행을 세분화할 수 있습니다. 다만 행이 너무 많아지면 feature 간 일관성이 깨지고 fallback 조합이 폭발합니다. 새 경로를 추가하기 전에는 기존 capability와 output contract로 해결할 수 없는지 확인하고, 꼭 필요할 때만 평가셋·fallback·observability를 함께 추가합니다. 가장 좋은 라우터는 가장 복잡한 라우터가 아니라, 팀이 어떤 요청이 어디로 가는지 설명할 수 있는 라우터입니다.

## provider 변경과 데이터 처리 조건

multi-provider fallback을 검토한다면 기술 호환성 외에 데이터 처리 조건도 확인해야 합니다. 고객 요청·사내 문서·사용자 식별자가 어느 region에서 처리되는지, provider가 데이터를 어떻게 보관하는지, 계약상 전송이 허용되는지, audit 요구를 충족하는지 확인합니다. primary와 fallback의 조건이 다르면, 모든 요청을 동일하게 전환할 수 없습니다. 민감 경로는 장애 때도 같은 승인된 provider 안에서만 재시도하거나, 응답을 보류해야 할 수 있습니다.

provider별 rate limit과 오류 형식도 다릅니다. 한 provider의 429가 짧은 backoff 뒤 재시도 가능한 상태인지, 전체 account quota가 소진된 것인지, 다른 provider 전환이 실제로 도움이 되는지 구분해야 합니다. provider adapter가 오류를 하나의 일반 오류로 뭉개면 라우터가 안전한 결정을 내리기 어렵습니다. 오류 분류·retry 정책·fallback 조건을 테스트하고, 비용 급증이나 외부 장애 때 어떤 기능을 우선 보호할지 운영 정책으로 정합니다.

## 사람 검토를 라우팅 결과에 연결하기

사람 검토는 모델이 약해서만 필요한 것이 아니라, 책임 있는 의사결정의 위치를 분명히 하는 장치입니다. 높은 위험의 계약 문서 요약, 보안 incident 초안, 대규모 계정 변경 제안은 모델이 근거를 정리하고 비교안을 만들게 할 수 있지만 최종 실행·발송은 승인자가 확인해야 합니다. 라우터는 이런 요청을 더 큰 모델로 보내는 대신 검토 queue와 필요한 evidence를 함께 만들 수 있습니다.

검토자에게 모델 답변만 던지면 검토 품질도 흔들립니다. 사용한 source, 선택한 model·prompt version, validator 결과, 대안 경로, 실패·fallback 이력을 보여 주되 민감한 chain-of-thought 같은 내부 추론을 요구하거나 저장하지 않습니다. 검토자는 결과와 근거를 기준으로 승인·수정·거절하고, 그 결정은 평가셋의 대표 실패 사례로 돌아갈 수 있습니다. 자동화와 사람 검토를 대립시키기보다, 어떤 위험에서 누구의 판단이 필요한지 분리하는 것이 라우팅의 목적입니다.

## 정기적으로 경로를 폐기하기

라우팅 규칙은 늘어나기만 하면 유지하기 어렵습니다. 사용량이 거의 없거나 quality 이점이 증명되지 않은 capability, 계속 primary보다 나쁜 fallback, 더 이상 지원되지 않는 model version은 정기 평가에서 제거 후보로 봅니다. 경로를 줄이면 관찰해야 할 조합과 장애 표면도 줄어듭니다. 새 모델을 추가하는 기준뿐 아니라, 어떤 근거가 있을 때 경로를 합치거나 폐기할지 정해 두면 라우터가 장기적으로 설명 가능한 구조를 유지합니다.

사용자에게 보이는 품질과 안전을 지키는 검증은 생략하지 않았습니다. 다만 별도 provider별 구현이나 복잡한 점수 기반 최적화는 실제 필요가 확인될 때까지 추가하지 않는 것이 위험을 줄입니다.

라우팅 변경은 모델 교체가 아니라 제품 동작 변경으로 취급해야 합니다. 평가 결과, rollout 범위, rollback 기준, 영향을 받는 fallback과 cache 정책을 release 기록에 남기면, 나중에 비용·품질 변화의 원인을 다시 확인할 수 있습니다.

작은 정책부터 평가·관찰·되돌림을 함께 적용하면 라우팅은 비용 절감 장치가 아니라 안정적인 제품 운영 경계가 됩니다.

모든 경로는 사용 목적과 실패 시 행동을 한 문장으로 설명할 수 있어야 합니다.

설명할 수 없는 자동 전환은 추가하기보다 제거하거나 검토 대상으로 남기는 편이 안전합니다.

## 한계와 적용 기준 Q&A

### Q. 라우팅을 하면 더 작은 모델로 비용을 반드시 줄일 수 있나요?

A. 아닙니다. 분류 호출, 재시도, fallback, validator, retrieval이 추가되면 단순 경로보다 비용과 지연이 늘 수 있습니다. 실제 요청 분포와 사용자 재질문까지 포함해 측정하고, 작은 모델이 충분한 작업에만 적용해야 합니다. 요청 수가 적고 품질 요구가 동일하다면 단일 모델이 더 단순하고 안전할 수 있습니다.

### Q. 모델의 confidence 점수만으로 자동 승인해도 되나요?

A. 모델이 제공하는 confidence는 작업의 실제 정확도나 업무 위험을 보장하지 않습니다. 고위험 작업은 deterministic rule, 권한 검사, 사용자 확인, 사람 검토처럼 모델 밖의 통제를 사용해야 합니다. confidence는 추가 신호일 수 있지만 승인 권한을 대신하지 않습니다.

### Q. provider가 장애면 다른 provider로 자동 전환해도 되나요?

A. 호환성·데이터 처리·보안·계약 조건을 사전에 검토한 경로에서만 가능합니다. prompt와 output schema, tool 실행, 데이터 보관 정책, regional 처리 요구, rate limit이 달라질 수 있습니다. 전환이 안전하지 않은 작업은 명확한 장애 안내와 재시도·이관 경로가 더 나을 수 있습니다.

### Q. 모든 요청을 로그로 남기면 라우팅 개선이 쉬워지지 않나요?

A. 원문 요청에는 개인정보·비밀·내부 정보가 있을 수 있습니다. 개선에 필요한 최소 metadata만 남기고, 민감한 원문은 마스킹·접근 제어·짧은 보관 기간·승인된 조사 절차 아래에서 다뤄야 합니다. 관찰성의 편의가 데이터 보호보다 우선하면 안 됩니다.

## 마무리

LLM 모델 라우팅의 목적은 가장 싼 모델을 찾는 일이 아니라, 각 요청에 필요한 품질·근거·응답 시간·비용·실행 권한을 설명 가능한 정책으로 만드는 것입니다. 기능과 출력 계약을 나누고, 낮은 위험 작업부터 평가하며, fallback을 별도 경로로 검증하고, token 예산과 관찰 신호를 함께 두세요. 그러면 여러 모델을 쓰더라도 사용자가 예측 가능한 품질을 받고, 팀은 비용과 장애를 근거로 조정할 수 있습니다.

<h3 class="references-heading">참고 자료</h3>

- [OpenAI API: Latency optimization](https://platform.openai.com/docs/guides/latency-optimization)
- [OpenAI API: Evals guide](https://platform.openai.com/docs/guides/evals)
- [OpenAI API: Structured Outputs](https://platform.openai.com/docs/guides/structured-outputs)
- [NIST AI Risk Management Framework](https://www.nist.gov/itl/ai-risk-management-framework)
