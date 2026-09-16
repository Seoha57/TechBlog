---
layout: post
title: "Kyverno로 Kubernetes 운영 기준을 정책 코드로 관리하기"
date: 2026-09-17 00:00:00 +0900
categories: [infrastructure]
tags: [infrastructure, kubernetes, kyverno, policy-as-code, itgc]
---

Kubernetes 클러스터에서 애플리케이션을 배포할 때 YAML 파일은 곧 운영 변경 요청입니다. `Deployment` 하나에는 컨테이너 이미지, CPU·메모리, 실행 권한, 레이블, 네트워크 설정이 들어갈 수 있습니다. 팀이 늘어나면 “모든 워크로드에 담당 팀 레이블이 있는가?”, “latest 태그는 금지하는가?”, “리소스 제한이 없는 Pod를 허용할 것인가?” 같은 기준을 사람의 리뷰만으로 지키기 어려워집니다.

이 글은 Kyverno를 예시로 Kubernetes 운영 기준을 정책 코드로 관리하는 방법을 설명합니다. 실제 운영 환경에서 적용하거나 감사 대응을 수행한 결과가 아니라, 공식 문서와 공개 자료를 바탕으로 한 학습용 정리입니다. 정책은 잘못 작성하면 정상 배포도 막을 수 있으므로, 처음부터 Enforce로 차단하기보다 영향 범위를 검토해야 합니다.

<section class="quick-answers"><p class="quick-label">먼저 답하면</p><div class="quick-answer"><h3>Q. Kubernetes 정책은 왜 필요한가요?</h3><p>A. YAML 배포가 늘수록 사람마다 다른 설정이 들어갈 수 있기 때문입니다. 정책은 배포 전에 공통 기준을 검사해 운영 실수와 통제 누락을 줄이는 방법입니다.</p></div><div class="quick-answer"><h3>Q. Kyverno는 보안 도구인가요?</h3><p>A. 보안에 많이 쓰이지만 범위는 더 넓습니다. 레이블, 리소스 제한, 이미지 출처, 네임스페이스 표준, 운영 메타데이터 등 클러스터 운영 기준을 검증·변경·생성할 수 있습니다.</p></div><div class="quick-answer"><h3>Q. 바로 배포를 차단해도 될까요?</h3><p>A. 권장하지 않습니다. 먼저 Audit 방식으로 위반 현황을 보고, 예외와 마이그레이션 계획을 정한 뒤 필요한 기준만 Enforce로 전환하는 편이 안전합니다.</p></div></section>

<figure class="article-figure"><img src="{{ '/assets/images/kyverno-policy-flow.svg' | relative_url }}" alt="Kyverno Policy as Code 흐름"><figcaption>이미지 출처: ChatGPT 생성</figcaption></figure>

## Kubernetes 정책과 Admission Control부터 이해하기

Kubernetes는 사용자가 API 서버에 보내는 요청으로 리소스를 생성·수정·삭제합니다. 예를 들어 `kubectl apply -f deployment.yaml`은 Deployment 생성 또는 변경 요청을 API 서버에 보내는 일입니다. API 서버는 인증과 권한 확인 뒤, 리소스가 저장되기 전에 Admission Control 단계를 거칠 수 있습니다.

Admission Controller는 이 시점에 요청 내용을 검사하거나 바꿀 수 있는 장치입니다. “이 이미지가 허용된 레지스트리에서 왔는가?”, “Pod에 메모리 제한이 있는가?” 같은 질문에 따라 요청을 허용하거나 거부할 수 있습니다. Kubernetes 공식 문서는 Admission Controller가 리소스 생성·수정·삭제 요청을 저장 전에 검사한다고 설명합니다. 이는 읽기 요청에는 적용되지 않습니다.

Kyverno는 Kubernetes에 맞춰 만든 정책 엔진입니다. 정책을 YAML 형태로 관리하고, Kubernetes의 동적 Admission Control과 연결해 배포 요청을 검증합니다. 공식 문서에 따르면 Kyverno는 정책을 검증(validate)하고, 필요한 값을 넣거나 바꾸며(mutate), 다른 리소스를 생성(generate)하거나, 이미지와 메타데이터를 확인하는 기능을 제공합니다.

## Policy as Code란 무엇인가

Policy as Code는 운영 기준을 문서나 사람의 기억에만 두지 않고, 버전 관리되는 코드로 표현하는 방식입니다. 예를 들어 “모든 운영 서비스에는 팀 이름 레이블이 필요하다”는 규칙을 위키에 적는 데서 멈추지 않고, 배포 요청을 검사하는 YAML 정책으로 만듭니다.

이 방식의 장점은 기준 자체도 Git에서 리뷰·변경 이력·롤백이 가능하다는 점입니다. ITGC나 변경관리 관점에서도 누가 어떤 기준을 언제 바꿨고, 어떤 배포가 기준을 통과하거나 위반했는지 추적할 근거를 만들 수 있습니다. 다만 정책 코드가 곧 감사 증거 전체를 대체하는 것은 아닙니다. 승인 절차, 예외 사유, 실제 운영 결과는 별도로 관리해야 합니다.

## 가장 단순한 검증 정책 예시

다음은 모든 Deployment에 `team` 레이블이 있는지 검사한다는 개념 예시입니다. Kyverno 버전별 API와 정책 유형이 발전하고 있으므로, 실제 도입 시에는 사용하는 버전의 공식 레퍼런스를 확인해야 합니다.

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: require-team-label
spec:
  validationFailureAction: Audit
  rules:
  - name: check-team-label
    match:
      any:
      - resources:
          kinds:
          - Deployment
    validate:
      message: "team 레이블이 필요합니다."
      pattern:
        metadata:
          labels:
            team: "?*"
```

이 정책은 Deployment가 생성될 때 `metadata.labels.team` 값이 있는지 확인합니다. `Audit` 모드에서는 정책 위반을 기록하지만 요청을 막지는 않습니다. 운영팀은 어떤 네임스페이스와 애플리케이션이 기준을 충족하지 못하는지 먼저 확인할 수 있습니다. 충분히 정리된 뒤 `Enforce`로 전환하면 위반 리소스가 배포되기 전에 차단됩니다.

예를 들어 개발팀이 아래처럼 team 레이블을 빼먹었다고 가정해 보겠습니다.

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: order-api
  labels:
    app: order-api
```

Audit 단계에서는 보고서에 위반으로 남고, Enforce 단계에서는 정책 메시지와 함께 배포가 거절될 수 있습니다. 중요한 점은 “정책이 맞는가”뿐 아니라 “이 정책을 지금 강제해도 업무가 멈추지 않는가”를 함께 판단하는 것입니다.

## Validate, Mutate, Generate를 구분하기

Kyverno 정책을 학습할 때 세 단어를 구분하면 이해가 쉬워집니다.

| 방식 | 하는 일 | 예시 |
| --- | --- | --- |
| Validate | 기준에 맞지 않으면 기록 또는 차단 | resource limits 없으면 위반 |
| Mutate | 누락된 값 추가 또는 값 변경 | 기본 레이블 자동 추가 |
| Generate | 조건에 맞는 다른 리소스 생성 | 새 namespace에 NetworkPolicy 생성 |
| Verify Images | 이미지 서명·출처 확인 | 승인되지 않은 이미지 거부 |

Validate는 가장 보수적인 시작점입니다. 기준에 맞지 않는 리소스를 알려주고, 어느 시점에 차단할지 선택할 수 있습니다. Mutate는 편리하지만 사용자가 입력한 YAML과 실제 저장된 YAML이 달라질 수 있으므로, 어떤 값이 자동으로 넣어지는지 팀에 충분히 알려야 합니다. Generate는 namespace 생성 시 기본 NetworkPolicy를 함께 만드는 식으로 표준화를 돕지만, 리소스 소유권과 삭제 규칙까지 설계해야 합니다.

Kyverno는 최근 CEL 기반 정책 유형으로 발전하고 있습니다. 공식 정책 개요는 오래된 ClusterPolicy 계열의 사용 중단 계획과 새 정책 유형의 상태를 설명합니다. 따라서 블로그나 예제에서 본 오래된 YAML을 그대로 운영에 적용하기보다, 현재 Kyverno 버전과 Kubernetes 버전에 맞는 API를 확인해야 합니다.

## 운영·감사 관점에서 연결하기

이 기술은 “보안 규칙을 하나 더 설치한다”로만 보면 아쉽습니다. 운영 기준을 자동 검사하고 보고서로 남길 수 있다는 점에서 변경관리와 ITGC의 통제 목표에도 연결할 수 있습니다.

예를 들면 다음과 같은 통제 질문을 정책으로 보조할 수 있습니다.

1. 운영 namespace에 승인되지 않은 이미지가 올라가지 않는가?
2. 모든 서비스에 담당 팀·서비스 이름·환경 레이블이 있는가?
3. Pod가 CPU·메모리 요청과 제한을 설정했는가?
4. privileged 컨테이너나 hostPath 사용이 제한됐는가?
5. 예외가 필요할 때 누가 어떤 기간 동안 허용했는가?

정책 결과는 운영 품질을 판단하는 입력값이 될 수 있습니다. 그러나 감사 요구사항은 조직마다 다르고, Kyverno Report는 현재 클러스터 상태를 중심으로 하므로 장기 보관·승인 이력·티켓 연계까지 자동으로 해결하지는 않습니다. 보고서, Git 변경 이력, CI 결과, 변경 요청 시스템을 함께 연결해야 더 신뢰할 수 있는 운영 증거가 됩니다.

## 도입 순서와 한계

처음에는 배포를 막지 않는 Audit 모드로 현황을 수집하는 것이 좋습니다. 팀 레이블이나 리소스 제한처럼 영향이 비교적 명확한 기준부터 시작하고, 위반 리소스를 고치는 과정에서 예외 정책이 정말 필요한지 확인합니다. 그 다음 새 서비스부터 Enforce를 적용하고, 기존 서비스에는 유예 기간을 둘 수 있습니다.

정책이 많아질수록 성능과 관리 부담도 생깁니다. 너무 넓은 범위를 매 요청마다 검사하면 API 서버와 Admission Webhook 경로에 부담을 줄 수 있습니다. 정책 간 충돌, 예외 남용, 자동 변경으로 인한 예상 밖의 결과도 점검해야 합니다. 그래서 정책 자체에 단위 테스트와 리뷰, 버전 호환성 확인이 필요합니다.

<section class="quick-answers"><p class="quick-label">한계와 적용 기준</p><div class="quick-answer"><h3>Q. Kyverno가 있으면 코드 리뷰가 필요 없나요?</h3><p>A. 아닙니다. Kyverno는 선언된 기준을 자동 검사할 뿐, 아키텍처 적절성이나 업무 영향은 판단하지 못합니다. 코드·YAML 리뷰와 정책 검증은 함께 필요합니다.</p></div><div class="quick-answer"><h3>Q. OPA와 Kyverno 중 무엇이 더 좋은가요?</h3><p>A. 목적과 팀 역량에 따라 다릅니다. Kyverno는 Kubernetes YAML 중심 정책을 시작하기 쉽고, OPA는 여러 시스템에 적용할 수 있는 범용 정책 엔진입니다. 먼저 해결하려는 통제 문제를 정하는 편이 중요합니다.</p></div><div class="quick-answer"><h3>Q. ITGC 대응을 Kyverno 하나로 할 수 있나요?</h3><p>A. 아닙니다. 정책은 기술적 통제의 일부입니다. 접근 권한, 변경 승인, 증적 보관, 장애 대응, 검토 절차는 조직의 통제 체계 안에서 별도로 관리해야 합니다.</p></div></section>

Kyverno는 Kubernetes 배포 기준을 사람의 기억에서 정책 코드로 옮기는 도구입니다. 취준생 관점에서는 Admission Control, 정책 검증, Audit과 Enforce의 차이부터 이해하면 충분한 출발점이 됩니다. 운영 관점에서는 작은 기준부터 자동화하고, 결과를 변경관리와 개선 활동에 연결하는 것이 핵심입니다.

### 참고 자료

- [Kyverno 공식 소개](https://kyverno.io/docs/introduction/)
- [Kyverno 정책 유형 개요](https://kyverno.io/docs/policy-types/overview/)
- [Kyverno 정책 적용 가이드](https://kyverno.io/docs/guides/applying-policies/)
- [Kyverno Policy Reports](https://kyverno.io/docs/guides/reports/)
- [Kubernetes Admission Control](https://kubernetes.io/docs/reference/access-authn-authz/admission-controllers/)
