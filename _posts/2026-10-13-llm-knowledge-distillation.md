---
layout: post
title: "LLM 지식 증류를 이해하는 법: Teacher·Student·합성 데이터·평가·배포 경계"
date: 2026-10-13 08:30:00 +0900
categories: [ai]
tags: [ai, llm, knowledge-distillation, small-language-model, fine-tuning, evaluation, synthetic-data]
description: "LLM 지식 증류를 처음 접하는 사람을 위해 teacher와 student 모델, 합성 학습 데이터, fine-tuning과의 관계, 품질·보안·비용 평가와 배포 기준을 설명합니다."
---

LLM 기능을 제품에 넣으면 큰 모델은 답을 잘하지만 지연·비용·GPU 요구가 부담스럽고, 작은 모델은 빠르고 저렴하지만 업무 품질이 부족해 보이는 순간이 옵니다. 이때 “큰 모델의 답을 작은 모델에게 가르치면 어떨까?”라는 접근이 **지식 증류(Knowledge Distillation)** 입니다. 큰 모델이나 여러 모델을 **teacher(교사 모델)** 로 사용해 입력에 대한 더 풍부한 출력·판단을 만들고, 더 작거나 운영하기 쉬운 **student(학생 모델)** 이 특정 업무에서 그 행동을 배우도록 훈련하는 방식입니다.

지식 증류는 모델 파일을 압축하는 버튼도, 큰 모델의 모든 능력을 작은 모델에 복사하는 마법도 아닙니다. 어떤 입력을 teacher에게 물을지, teacher의 출력 중 무엇을 정답으로 채택할지, 개인정보와 비밀정보를 어떻게 제외할지, student가 실제 사용자 질문에서 어느 정도 품질을 유지해야 하는지, 실패할 때 큰 모델로 보낼지 사람에게 보낼지를 설계해야 합니다. 잘못된 teacher 답이나 편향된 synthetic data(합성 데이터)를 대량으로 학습하면, 작은 모델은 그 오류를 더 저렴하게 반복할 수 있습니다.

이 글은 OpenAI API 또는 특정 오픈 모델에 한정하지 않고, LLM distillation을 제품·운영 관점에서 설명합니다. Fine-tuning, RAG, 양자화와 무엇이 다른지부터 시작해, 고객 문의 분류·요약 서비스를 예로 teacher/student 경계와 평가·배포 절차를 다룹니다.

<section class="quick-answers">
  <p class="quick-label">먼저 답하면</p>
  <div class="quick-answer"><h3>Q. 지식 증류는 단순 Fine-tuning과 다른가요?</h3><p>A. Fine-tuning은 모델을 특정 데이터로 추가 학습하는 넓은 방법이고, distillation은 teacher의 출력·확률·추론 예시를 학습 신호로 써 student를 훈련하는 목적과 데이터 생성 전략입니다. 실제 구현에서는 teacher가 만든 예시로 student를 fine-tune할 수 있습니다.</p></div>
  <div class="quick-answer"><h3>Q. 큰 모델의 성능을 작은 모델이 그대로 얻나요?</h3><p>A. 아닙니다. 특정 범위가 좁고 데이터가 잘 대표될 때 일부 작업 품질을 가깝게 만들 수 있지만, 일반 지식·복잡한 추론·긴 문맥·새로운 예외까지 동일해진다고 기대하면 안 됩니다. 대상 업무와 평가 경계를 좁혀야 합니다.</p></div>
  <div class="quick-answer"><h3>Q. Teacher API 응답을 모아 학습해도 되나요?</h3><p>A. 먼저 제공자의 사용 조건, 데이터 처리 약정, 개인정보·저작권·사내 비밀 정책을 확인해야 합니다. teacher 출력에도 원문 민감정보나 잘못된 사실이 섞일 수 있으므로, 수집·검토·보관·삭제 정책 없이 자동 학습 데이터로 쓰면 안 됩니다.</p></div>
</section>

## 먼저 알아둘 기반 기술: 모델·추론·학습·토큰·평가 세트

**LLM(Large Language Model, 대규모 언어 모델)** 은 입력 토큰을 보고 다음 토큰의 확률 분포를 계산해 문장을 생성하는 모델입니다. **추론(inference)** 은 이미 학습된 모델이 사용자 요청에 답을 만드는 실행 단계이고, **학습(training)** 은 데이터와 손실 함수(loss function)를 이용해 모델의 파라미터를 바꾸는 단계입니다. 큰 모델을 API로 호출할 때 비용·지연이 생기는 것은 주로 추론 단계이며, student를 만드는 과정은 별도의 데이터 준비·학습·평가 비용을 가집니다.

**Fine-tuning(파인튜닝)** 은 기반 모델에 업무 예시를 추가 학습해 출력 형식·분류·문체·행동을 맞추는 방법입니다. **RAG(Retrieval-Augmented Generation, 검색 증강 생성)** 는 문서를 검색해 실행 시점의 프롬프트에 넣어 최신 근거를 제공하는 시스템 구조입니다. **양자화(quantization)** 는 모델 가중치의 숫자 표현을 줄여 메모리·연산 사용량을 낮추는 기술입니다. distillation은 teacher가 만든 학습 신호를 이용해 student의 행동을 특정 업무에 맞추는 방법입니다. 이 기술들은 경쟁 관계가 아니라 서로 다른 계층에 있을 수 있습니다. 예를 들어 RAG로 최신 문서를 제공하고, student를 JSON 분류 형식에 맞게 distill하며, student를 양자화해 로컬 서버에서 실행할 수 있습니다.

**평가 세트(eval set)** 는 모델의 좋고 나쁨을 비교하기 위해 따로 보관한 대표 입력과 기대 조건의 묶음입니다. 학습에 쓴 예시를 그대로 평가하면 모델이 외운 패턴만 확인할 수 있으므로, 실제 배포 전에 처음 보는 질문·긴 입력·오탈자·경계 사례·거부해야 하는 요청을 포함한 holdout set이 필요합니다. LLM의 정답은 하나가 아닐 수 있으므로 문자열 일치뿐 아니라 필수 사실, 금지 표현, JSON schema, 근거 인용, 도구 호출 여부 같은 평가 기준을 정해야 합니다.

## Teacher가 주는 것은 답 하나보다 넓다

전통적인 지식 증류에서 teacher는 class마다 얼마나 그럴듯한지 나타내는 soft probability를 student에게 전달할 수 있습니다. 예를 들어 이미지가 고양이일 확률뿐 아니라 개·여우와 어느 정도 비슷한지도 학습 신호가 될 수 있습니다. LLM 제품에서는 개발자가 teacher의 최종 답변, 구조화된 라벨, step-by-step 설명, 선택한 도구, 거절 사유, 평가 점수처럼 관찰 가능한 출력을 데이터로 사용하는 경우가 많습니다. 어떤 신호를 저장·학습할지는 업무 위험도와 데이터 정책을 먼저 따라야 합니다.

customer support 분류를 생각해 보겠습니다. teacher에게 문의를 주고 `배송 지연`, `환불`, `계정`, `보안 의심`, `사람 검토 필요` 중 하나의 category와 근거 요약을 JSON으로 만들게 할 수 있습니다. student는 이 예시를 학습해 더 빠르고 저렴하게 첫 분류를 수행할 수 있습니다. 그러나 teacher가 민감한 계정 복구 문의에서 잘못된 자동 조치를 제안했다면 그 출력을 그대로 학습하면 안 됩니다. high-risk label은 정책 규칙과 사람 검토를 먼저 통과시켜야 합니다.

```json
{
  "input": "퇴사한 직원의 계정이 아직 로그인됩니다.",
  "teacher_output": {
    "category": "account_offboarding",
    "priority": "high",
    "needs_human": true,
    "reason": "계정 접근 권한과 보안 정책 확인이 필요합니다."
  },
  "review_status": "approved_for_training"
}
```

이 데이터 구조에서 가장 중요한 필드는 teacher의 화려한 설명이 아니라 `review_status`입니다. training set은 teacher가 생성했다는 이유만으로 신뢰되는 것이 아니라, 입력의 사용 권한·민감도·정답 기준·검토 상태가 확인되어야 합니다. student는 결국 데이터가 표현하는 정책을 배웁니다.

## Distillation이 맞는 문제와 맞지 않는 문제

distillation은 반복되는 좁은 업무에서 특히 검토할 가치가 있습니다. 입력 형식은 다양하지만 출력 라벨은 제한된 티켓 분류, 정해진 schema를 만드는 정보 추출, 특정 톤의 짧은 요약, 정해진 언어 쌍의 변환, 반복적인 문서 태깅 같은 작업입니다. 이 작업들은 충분한 대표 예시와 명확한 평가 기준을 만들 수 있고, 큰 teacher를 매 요청에 호출하지 않아도 student가 많은 요청을 처리할 수 있습니다.

반대로 최신 사실을 정확히 답해야 하는 정책 질의, 사용자마다 권한이 다른 사내 문서 검색, 수백 페이지의 문맥을 비교해야 하는 분석, 드문 고위험 예외를 독립적으로 판단해야 하는 업무는 student 학습만으로 풀기 어렵습니다. 최신 지식은 RAG나 원본 시스템 조회로 제공하고, 위험한 결과는 규칙·사람 승인·강한 모델 검토가 필요할 수 있습니다. “작은 모델이 대답했다”는 사실은 근거·권한·승인 조건을 만족했다는 증거가 아닙니다.

| 요구 | 우선 검토 | distillation의 위치 |
| --- | --- | --- |
| 최신 문서의 근거 있는 답변 | RAG·권한 필터 | 출력 형식 보정에 보조 사용 가능 |
| 반복 티켓의 제한된 라벨 분류 | 규칙·baseline 모델·평가 세트 | 대표 예시로 student 학습 후보 |
| 법무·의료·보안의 고위험 판단 | 사람 승인·전문 정책 | 자동 결론을 대신하지 않음 |
| 긴 자유 형식 글쓰기 | prompt·편집 workflow | 특정 톤·구조에 제한적으로 사용 |
| 지연·비용이 매우 중요한 대량 요청 | workload 측정·SLO | 좁은 작업의 student를 실험할 수 있음 |

## 합성 데이터: 양보다 대표성과 검토가 먼저

teacher가 수백만 개의 예시를 빠르게 만들 수 있다는 점은 매력적이지만, 입력 분포가 나쁘면 데이터 양은 품질을 보장하지 않습니다. 실제 고객은 짧은 단어, 오탈자, 여러 언어, 모호한 요구, 화난 표현, 여러 문제가 섞인 문의를 보냅니다. policy 문서만 바탕으로 정제된 질문을 생성하면 student는 교과서 문제에는 강하지만 실제 입력에는 약할 수 있습니다. 따라서 production 데이터 사용 권한이 있을 때는 비식별화·샘플링·검토를 거쳐 대표적인 형태를 추출하고, 없을 때는 실제 업무의 변형을 반영한 synthetic scenario를 사람이 설계해야 합니다.

데이터 품질 점검은 중복·누수·편향을 포함합니다. 동일한 질문을 표현만 바꿔 여러 번 넣으면 training loss는 좋아 보여도 일반화는 나아지지 않을 수 있습니다. 평가 세트 질문을 teacher에게 생성시키고 training에도 넣으면 offline 결과가 과장됩니다. 특정 팀의 용어만 들어가면 다른 팀 사용자는 잘못 분류될 수 있습니다. 민감 라벨이 적으면 student가 대부분의 요청을 안전한 일반 라벨로 보내 accuracy가 높아 보일 수도 있습니다. class별 precision·recall, 사람 검토 전송률, 위험한 false negative를 따로 봐야 합니다.

teacher 출력도 검토 대상입니다. hallucination, 잘못된 policy 해석, 과도한 확신, 원치 않는 개인 정보 재진술, formatting 오류가 섞일 수 있습니다. 모든 데이터를 사람이 읽는 비용이 너무 크다면, 먼저 결정적 schema validation·금칙어·PII 탐지·중복 제거를 하고, 위험도 높은 label과 무작위 sample을 사람이 검토하는 계층을 둘 수 있습니다. 자동 필터는 사람 검토를 없애는 장치가 아니라 검토 대상을 우선순위화하는 장치입니다.

## Teacher와 Student를 평가하는 방법

student의 목표는 teacher와 똑같은 문장을 만드는 것이 아니라, 정의한 업무 품질을 만족하는 것입니다. teacher가 장황한 설명을 했더라도 product가 필요한 것은 정확한 category와 안전한 escalation일 수 있습니다. 따라서 평가 기준은 business contract에서 출발해야 합니다. 예를 들어 분류 서비스라면 schema valid rate, label accuracy, high-risk recall, 사람에게 넘겨야 할 경우의 abstention 품질, p95 latency, 요청당 비용을 함께 봅니다.

평가에는 최소 세 가지 비교가 필요합니다. 첫째 기존 baseline—규칙 기반 또는 현재 작은 모델—과 student를 비교해 distillation이 실제 가치를 주는지 봅니다. 둘째 teacher와 student를 같은 holdout set에 적용해 품질 차이를 봅니다. 셋째 student가 실패한 사례를 사람이 읽어 데이터·label definition·모델 한계 중 어디가 원인인지 분류합니다. teacher보다 조금 낮은 score라도 latency·비용·privacy 요구를 만족해 제품에 적합할 수 있고, 반대로 평균 score가 높아도 보안 의심 문의를 놓치면 배포하면 안 될 수 있습니다.

```text
평가 입력
  → baseline / teacher / student에 같은 조건으로 요청
  → schema·금지 규칙·권한 조건의 결정적 검사
  → 라벨·필수 사실·거부 여부의 기준 기반 채점
  → 고위험 실패는 사람 검토
  → 품질 + 지연 + 비용 + fallback 비율을 함께 비교
```

LLM-as-a-Judge는 자연어 요약의 유용성처럼 문자열 일치가 어려운 품질을 보조 평가할 수 있지만, judge도 오류와 편향을 가집니다. 위험한 정책 판단을 model judge 점수 하나로 승인하면 안 됩니다. 명확한 규칙은 코드로 검사하고, judge는 사람 평가와 calibration을 거친 보조 신호로 쓰는 편이 낫습니다.

## 배포: 모든 요청을 Student에게 보내지 않는다

실제 서비스에서는 routing 정책이 필요합니다. 단순하고 낮은 위험의 분류·요약은 student가 처리하고, 입력이 너무 길거나 schema validation에 실패하거나 confidence가 낮거나 고위험 키워드가 있으면 teacher 또는 사람 검토 큐로 보낼 수 있습니다. 그러나 fallback은 가용성 장치인 동시에 데이터 경로 변경입니다. student는 온프레미스에서 처리하지만 teacher는 외부 API라면, fallback 시 어떤 데이터가 어디로 전송되는지 사용 조건·보안 정책·사용자 고지를 확인해야 합니다.

confidence라는 숫자도 맹신하면 안 됩니다. 모델이 높은 확신으로 틀릴 수 있으며, 서로 다른 모델의 확신 값은 직접 비교하기 어렵습니다. routing 기준은 confidence 하나보다 입력 길이·지원 언어·schema 오류·명시적 위험 label·평가에서 확인된 실패 패턴을 조합해 시작합니다. 처음에는 자동 fallback보다 로그만 남기는 shadow mode를 써서 student가 어떤 요청을 처리했을지, teacher와 얼마나 달랐는지 확인할 수 있습니다. shadow 결과에도 실제 개인정보가 남을 수 있으므로 로그 접근과 보관 정책을 지켜야 합니다.

배포 전에는 failure mode를 연습합니다. student model load가 실패하면 안정 revision으로 되돌릴지, 기능을 잠시 제한할지, teacher에게 보낼지 결정합니다. teacher API rate limit이 발생하면 backlog를 쌓을지 사용자에게 재시도를 안내할지 정합니다. schema가 깨진 출력은 자유 텍스트로 조용히 통과시키지 말고 validator가 거부하고 안전한 경로로 보내야 합니다. AI 모델을 바꾸는 작업은 ML 실험이면서 사용자-facing dependency 변경입니다.

## 업무 예시: 상담 문의 1차 분류를 작게 증류하기

IT 헬프데스크가 매일 수천 건의 짧은 문의를 받는다고 가정하겠습니다. 상담사는 먼저 `접근 권한`, `VPN`, `장비`, `소프트웨어 설치`, `보안 의심`, `기타`로 분류하고, 보안 의심·퇴사자 계정·관리자 권한 요청은 반드시 사람에게 넘겨야 합니다. 현재 큰 teacher 모델은 분류 품질이 좋지만 모든 요청을 처리하기에는 비용과 latency가 부담됩니다.

첫 단계는 teacher에게 대량의 실제 문의를 무단으로 보내는 것이 아니라, 승인된 비식별 예시와 사람이 설계한 edge case로 평가 세트를 만드는 것입니다. label 정의와 escalation 규칙을 합의한 뒤, teacher의 JSON 출력에 schema validation과 민감정보 필터를 적용하고 위험 label은 사람이 sample review합니다. 이 데이터를 이용해 student를 학습한 뒤, holdout에서 category accuracy만 아니라 `보안 의심` recall과 `needs_human` 누락률을 봅니다.

배포는 일정 비율의 shadow traffic으로 시작할 수 있습니다. 실제 상담 화면에는 기존 teacher 또는 사람 분류 결과를 보여 주되, student 결과를 별도 로그에서 비교합니다. student가 정상 문의를 빠르게 분류하지만 위험 문의를 종종 `기타`로 보내는 것이 드러나면, 데이터·label·routing을 고치기 전에는 auto assignment를 열지 않습니다. 반대로 지원 범위가 좁은 `소프트웨어 설치` 문의에서 충분한 결과가 나오면 그 경로만 student 자동 분류로 열 수 있습니다. ‘모델 전체를 교체한다’가 아니라 업무 경계별로 증거를 쌓는 방식입니다.

## 데이터 거버넌스: 학습 가능한 데이터와 볼 수 있는 데이터는 다르다

사용자가 상담을 남겼다고 해서 그 내용이 자동으로 teacher prompt, 학습 데이터, model artifact, 개발자 notebook, 평가 대시보드에 모두 저장돼도 된다는 뜻은 아닙니다. 데이터의 수집 목적, 동의·계약, 사내 접근 권한, 보관 기간, 지역 규정, 삭제 요청, 제공자 처리 조건을 나눠 확인해야 합니다. 특히 teacher가 외부 API라면 입력이 어떤 국가·리전에 처리되는지, provider가 학습에 사용하는지, 로그 보관을 어떻게 하는지 조직의 보안·법무 정책과 맞춰야 합니다.

학습 데이터 파이프라인은 원본 식별자와 필요 이상의 원문을 student training file에 복사하지 않는 방향이 좋습니다. 이메일·전화번호·계정 ID·주소·access token 같은 직접 식별자와, 여러 정보가 결합되면 개인을 알아볼 수 있는 간접 식별자를 찾아 최소화합니다. 단순한 정규식 마스킹만으로 모든 PII(Personally Identifiable Information, 개인 식별 정보)를 찾을 수 있다고 믿으면 안 됩니다. 사람이 검토해야 하는 고위험 sample과 자동 필터의 한계를 명시합니다.

또한 teacher의 장황한 설명에는 prompt에 있던 비밀 문장이 다시 포함될 수 있습니다. student가 특정 질문에 그 문장을 그대로 재생성하지 않더라도, training corpus에 불필요한 비밀이 남는 것 자체가 위험입니다. 학습 전 데이터와 학습 후 artifact의 접근 권한, encryption, backup, 폐기 절차를 문서화하고, 누가 어떤 dataset version으로 모델을 만들었는지 추적합니다. 이 기록은 audit만을 위한 것이 아니라 잘못된 label이나 삭제 요청이 발견됐을 때 영향 범위를 찾기 위한 운영 정보입니다.

## Synthetic data 품질을 검증하는 작은 파이프라인

합성 데이터 생성은 다음처럼 한 번에 teacher에게 “예시 10만 개를 만들어 줘”라고 요청하는 작업이 아닙니다. 먼저 task specification을 작성합니다. 입력 형식, 허용 label, 모호한 경우의 기본 행동, 금지된 자동 행동, 사람에게 넘길 기준, 지원 언어와 길이를 합의합니다. 다음으로 사람이 만든 seed example과 edge case를 마련합니다. teacher는 이 seed를 변형하거나 부족한 조합을 채우는 보조 역할을 합니다.

생성된 예시는 schema validation, 중복·거의 중복된 문장 제거, 금지 정보 탐지, label 분포 점검, 길이·언어·난이도 분포 점검을 거칩니다. 예를 들어 `security_incident`가 전체의 0.1%인데 synthetic set에서는 20%라면 student가 실제 요청에서 과도하게 사람에게 넘길 수 있습니다. 반대로 위험 label이 거의 없으면 high-risk recall을 측정할 근거가 없습니다. 실제 production 분포를 알 수 없는 경우에도, 팀이 정의한 risk scenario를 평가 세트에 별도로 넣어 일반 accuracy에 묻히지 않게 합니다.

```text
업무 명세와 seed example
  → teacher가 후보 예시 생성
  → 형식·PII·금칙어·중복 자동 검사
  → label 분포와 edge case 검토
  → 고위험/무작위 표본 사람 검토
  → versioned training set 확정
  → student 학습과 holdout 평가
```

이 파이프라인은 작은 team에서도 CSV 한 파일, validation script, 리뷰 표본으로 시작할 수 있습니다. 처음부터 거대한 MLOps 플랫폼을 만들 필요는 없습니다. 다만 training set과 eval set을 같은 파일에서 관리하거나, review하지 않은 raw teacher output을 곧바로 학습에 넣는 지름길은 나중에 원인을 추적하기 어렵게 만듭니다.

## 비용과 지연을 요청 단가가 아니라 전체 흐름으로 계산한다

distillation을 검토하는 흔한 이유는 큰 model API의 token 비용과 latency입니다. 하지만 의사결정에는 teacher 데이터 생성 호출, 사람이 review하는 시간, student training 비용, GPU 또는 inference server, model registry, monitoring, fallback 호출, on-call 대응을 포함해야 합니다. 월 요청량이 작고 업무 요구가 매주 바뀐다면 teacher prompt를 개선하는 편이 더 낮은 총비용일 수 있습니다. 반대로 매우 많은 요청이 좁은 schema를 반복하고 student가 충분한 품질을 낸다면 model 운영 비용을 감수할 이유가 생길 수 있습니다.

지연도 평균만 보면 안 됩니다. 사용자가 체감하는 것은 p95·p99 latency, queue wait, cold start, 모델 load, fallback 발생 시의 긴 경로일 수 있습니다. student가 평균적으로 빠르더라도 5% 요청이 teacher fallback으로 가서 user timeout을 만들면 제품 요구를 만족하지 못할 수 있습니다. student와 teacher 각각의 timeout, retry budget, cancellation, streaming 여부, queue 정책을 명시하고, request class별로 관찰합니다.

| 비용 또는 품질 항목 | teacher-only | distilled student | 함께 확인할 질문 |
| --- | --- | --- | --- |
| 요청 지연 | 모델·제공자에 따라 다름 | 더 작을 수 있음 | p95/p99과 fallback 경로는 어떤가 |
| 요청 단가 | token·모델별 과금 | 인프라/호스팅 비용 포함 | 월 volume에서 총비용은 어떤가 |
| 최신 지식 | prompt/RAG로 제공 가능 | 학습만으로 갱신 어려움 | 문서 변경 주기는 어떤가 |
| 품질 변경 | provider/model revision 영향 | dataset·training revision 영향 | holdout과 위험 사례가 통과했는가 |
| 운영 책임 | API key·rate limit | model server·artifact·capacity | 팀이 on-call할 수 있는가 |

이 표는 어느 방식이 항상 싸다고 말하지 않습니다. 제품의 request volume, data sensitivity, 운영 인력, 목표 latency, 업무의 안정성이 결론을 바꿉니다. 수치를 모르면 작은 traffic slice에서 shadow comparison을 수행해 실제 비용·지연·실패율을 관찰한 뒤 판단하는 편이 낫습니다.

## 모델 버전과 변경 관리를 제품 변경처럼 다룬다

student model은 파일 하나가 아니라 dataset version, base model revision, training code·hyperparameter, tokenizer, system prompt, output schema, inference runtime이 합쳐진 결과입니다. 이 중 하나라도 바뀌면 결과가 달라질 수 있습니다. 따라서 배포 artifact에 최소한 base model ID, training data hash 또는 version, eval set version, schema version, 생성일, 승인자, rollback 대상 revision을 기록합니다. 재현 가능한 기록이 없으면 “지난주에는 되던 분류가 왜 오늘 달라졌나”에 답하기 어렵습니다.

canary deployment는 모든 사용자를 새 student로 즉시 전환하지 않고, 일부 낮은 위험 traffic에 적용해 quality·latency·error를 보는 방식입니다. shadow deployment는 새 model 결과를 계산하되 실제 사용자 흐름에는 쓰지 않고 기존 결과와 비교하는 방식입니다. 둘 다 데이터와 비용을 쓰므로 범위·기간·로그 보관을 정해야 하지만, 대규모 자동 배정 전에 실제 input distribution을 볼 수 있다는 장점이 있습니다.

rollback 기준도 미리 정합니다. JSON validation error가 일정 비율을 넘으면 즉시 이전 revision으로 되돌릴지, high-risk false negative가 하나라도 발견되면 자동 기능을 끌지, latency가 SLO를 넘으면 teacher fallback 또는 기능 제한을 할지 결정합니다. 단순 accuracy 저하는 원인 분석을 위해 수집할 수 있지만, 보안·권한·금전 관련 위험은 더 낮은 임계값과 사람 escalation이 필요할 수 있습니다. 이 기준이 없으면 incident 중에 비용·품질·안전을 동시에 즉흥적으로 결정하게 됩니다.

## Distillation 실패를 읽는 방법

student가 teacher보다 나쁜 결과를 냈다고 해서 모델 크기만 탓하면 개선이 어렵습니다. 첫째 training set이 실제 입력을 대표하지 않는지 봅니다. 둘째 label definition이 애초에 모호한지, 사람 reviewer끼리도 일치하지 않는지 봅니다. 셋째 teacher output이 틀리거나 일관되지 않은지 봅니다. 넷째 tokenizer·context limit·inference prompt가 training과 달라졌는지 봅니다. 다섯째 schema parser나 routing rule이 student의 정상 답을 실패로 분류하는지 봅니다.

실패 사례는 유형별로 모아 다음 dataset 개선으로 연결합니다. 긴 입력을 놓치면 truncation 정책과 긴 문서 sample을, 여러 의도가 섞인 요청을 틀리면 multi-label 또는 escalation 기준을, 은어와 오탈자를 놓치면 representative variation을, 고위험 false negative를 내면 별도 rule·human gate를 검토합니다. 이 과정에서 성능을 올리기 위해 위험 label을 무조건 teacher로 넘기는 것도 한 방법이지만, 그 fallback 비율이 커지면 student 도입의 목적이 약해질 수 있습니다. 각 선택의 비용과 안전성을 숫자와 사례로 설명해야 합니다.

## 작게 시작하는 적용 순서

1. 사용자 영향이 낮고 출력 계약이 명확한 task 하나를 고른다. 예: 내부 문서의 제한된 태그 분류.
2. 사람이 합의한 label·금지 조건·escalation 규칙과 holdout eval set을 만든다.
3. baseline prompt 또는 rule 기반 결과를 기록한다. teacher가 정말 필요한지 확인한다.
4. 권한이 확인된 seed data로 teacher 후보를 만들고, 자동 검사와 사람 sample review를 한다.
5. student를 학습한 뒤 quality·schema·latency·cost·위험 실패를 baseline과 비교한다.
6. shadow → 낮은 위험 canary → 점진 확장 순서로 열고, rollback 기준을 적용한다.

이 순서가 느려 보일 수 있지만, 대규모 synthetic corpus와 model serving을 먼저 만든 뒤 “이 업무는 규칙 20줄이면 됐는데” 또는 “최신 문서를 찾아야 하는데 학습만 했다”는 사실을 발견하는 비용을 줄입니다. distillation은 model 프로젝트가 아니라 업무 계약을 더 작고 예측 가능한 실행 단위로 옮기는 제품 작업입니다.

## Teacher 선택도 평가 대상이다

teacher가 더 큰 모델이라는 사실만으로 좋은 training signal을 보장하지 않습니다. 해당 업무의 언어·도메인·JSON 형식·안전 거부·긴 입력 처리에서 teacher가 실제로 기준을 만족하는지 holdout으로 먼저 확인해야 합니다. teacher가 불안정하면 student는 그 불안정을 압축합니다. 여러 teacher를 비교하거나, 사람이 작성한 gold example을 일부 섞어 teacher 출력의 품질을 calibration하는 방법을 검토할 수 있습니다.

teacher prompt도 dataset의 일부입니다. system instruction, few-shot example, temperature, tool availability가 바뀌면 생성되는 label과 설명의 분포가 달라질 수 있습니다. 따라서 dataset metadata에 teacher model revision과 prompt version을 기록하고, 같은 input을 다시 생성했을 때 왜 결과가 달라졌는지 추적할 수 있어야 합니다. 재현성을 잃으면 student 품질 변화가 학습 때문인지 teacher generation 설정 때문인지 구분할 수 없습니다.

## 지식 증류와 사용자 신뢰

사용자는 응답을 만든 모델의 크기보다 결과가 정확하고 안전하며 설명 가능한지를 경험합니다. student가 처리한 결과라도 중요한 업무에서는 어떤 rule과 source를 따랐는지, 자동 처리인지 사람 검토가 필요한지, 수정·이의 제기 경로가 무엇인지 알려야 합니다. 특히 자동 분류가 티켓 우선순위나 접근 권한에 영향을 준다면, 사용자는 잘못된 결과를 바로 고칠 수 있어야 합니다.

이런 피드백은 다음 eval set의 중요한 입력이 됩니다. 단, 사용자 피드백을 곧바로 training data에 넣지 말고 개인정보·악의적 입력·label 품질을 검토합니다. 실사용 데이터는 모델 개선에 유용하지만, 가장 강한 data source일수록 거버넌스와 검토가 필요합니다. 안전한 distillation은 작은 모델을 배포하는 일뿐 아니라, 잘못된 모델 결과를 발견하고 되돌리는 사용성까지 포함합니다.

마지막으로 distillation 결과를 모델 벤치마크 순위와 혼동하지 않는 것이 중요합니다. student는 일반적인 모든 질문에서 teacher를 이기려는 모델이 아니라, 명확히 정의한 업무 계약을 더 경제적으로 수행하는 구성 요소입니다. 지원 범위 밖 질문에서 모른다고 말하거나 사람에게 넘기는 행동도 품질의 일부입니다. 이 경계를 명확히 하면 작은 모델의 한계를 숨기지 않으면서도 실제 제품에 안전하게 쓸 수 있습니다.

student가 단순한 입력을 처리해도, 그 결과를 받아 실제 계정 변경·결제·배포를 실행하는 시스템은 별도 권한 검증을 유지해야 합니다. distillation은 자연어 판단 비용을 낮출 수 있지만 신뢰 경계를 없애지 않습니다.

모델이 작아졌다는 이유로 운영 책임이 작아지는 것은 아닙니다. 오히려 더 많은 요청을 빠르게 처리하게 되면 잘못된 label이나 정책 해석도 더 넓게 퍼질 수 있습니다. 그래서 배포 범위와 rollback 경계는 모델 크기보다 업무 영향으로 정합니다.

좋은 distillation은 더 작은 모델을 만드는 데서 끝나지 않고, 잘못된 결과를 감지해 안전하게 수정하는 운영 루프를 만듭니다. 이 루프가 없다면 낮은 비용은 빠른 오류 확산의 비용이 될 수 있습니다.

## 한계와 적용 기준 Q&A

### Q. Teacher 모델의 답을 많이 모으면 사람 검토는 필요 없나요?

A. 필요합니다. teacher도 틀리거나 편향될 수 있고, 입력에 민감정보·저작권·권한 문제가 섞일 수 있습니다. 특히 고위험 label, 정책 해석, 자동 실행으로 이어지는 출력은 사람이 정한 기준과 검토 절차가 필요합니다. 자동 검사와 표본 검토로 비용을 조절할 수는 있어도 책임을 없앨 수는 없습니다.

### Q. Distillation은 API 비용을 반드시 줄이나요?

A. student 추론 비용이 낮을 수 있지만, 데이터 생성·검토·학습·호스팅·모니터링 비용이 새로 생깁니다. 요청량이 작거나 요구가 자주 바뀌면 teacher API를 그대로 쓰는 편이 단순할 수 있습니다. 대상 업무의 volume, latency SLO, 데이터 정책, 유지보수 역량을 포함해 총비용을 평가해야 합니다.

### Q. 작은 student를 로컬에서 돌리면 개인정보 문제는 모두 해결되나요?

A. 아닙니다. training data와 prompt log, model artifact, vector store, backup, 운영자 접근 권한은 여전히 보호해야 합니다. 로컬 실행은 전송 경로 하나를 줄일 수 있지만 데이터 최소화·암호화·감사·삭제 요구를 자동으로 만족시키지 않습니다.

### Q. Distillation과 RAG를 같이 쓰면 더 정확한가요?

A. 서로 다른 문제를 해결하므로 조합할 수는 있습니다. RAG는 최신 근거를, distillation은 형식·분류·요약 행동을 보정할 수 있습니다. 그러나 components가 늘면 검색 오류·학습 오류·routing 오류를 분리해 평가해야 합니다. 작은 RAG 또는 작은 student 하나로 해결되는 문제에 두 시스템을 동시에 추가할 필요는 없습니다.

## 마무리

지식 증류는 큰 모델의 능력을 작은 모델에 통째로 복사하는 기술이 아니라, 명확히 정의한 좁은 업무에서 teacher의 좋은 행동을 학습 데이터로 바꾸고 student가 그 계약을 지키는지 검증하는 과정입니다. 그 과정의 비용은 모델 호출만이 아니라 데이터 대표성, 민감정보 처리, 사람 검토, evaluation, routing, rollback에 있습니다.

따라서 먼저 baseline과 holdout 평가 세트를 만들고, teacher 데이터의 권한·정확성·검토 상태를 확인하세요. 이후 낮은 위험의 한 경로에서 student를 shadow mode로 비교하고, 품질·지연·비용·고위험 실패를 함께 본 뒤 점진적으로 배포합니다. 이 순서를 따르면 distillation은 유행어가 아니라 제품의 규모와 책임 경계에 맞는 선택지가 됩니다.

<h3 class="references-heading">참고 자료</h3>

- [Hinton, Vinyals, Dean, Distilling the Knowledge in a Neural Network](https://arxiv.org/abs/1503.02531)
- [Gou et al., Knowledge Distillation: A Survey](https://arxiv.org/abs/2006.05525)
- [OpenAI Developers, Fine-tuning and model distillation resources](https://developers.openai.com/learn/fine-tuning)
- [OpenAI Platform Docs, Fine-tuning guide](https://platform.openai.com/docs/guides/fine-tuning)
- [OpenAI Platform Docs, Model optimization](https://platform.openai.com/docs/guides/model-optimization)
