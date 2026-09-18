---
layout: post
title: "OpenTelemetry Collector로 관측 데이터를 모으고 보내는 방법"
date: 2026-09-17 00:00:00 +0900
categories: [infrastructure]
tags: [infrastructure, opentelemetry, collector, observability, monitoring]
---

서비스가 늘어나면 로그는 애플리케이션마다, 메트릭은 서버마다, trace는 일부 서비스에만 흩어지기 쉽습니다. 관측 도구를 교체하거나 여러 팀이 서로 다른 라이브러리를 사용하면 데이터 형식과 전송 방식도 달라집니다. OpenTelemetry Collector는 이런 관측 데이터를 한곳에서 받아 가공하고 여러 목적지로 전달하는 구성 요소입니다.

이 글은 Trace·Metric·Log가 무엇인지, Collector가 애플리케이션 SDK와 무엇이 다른지부터 설명합니다. 실제 운영 환경에서 수집한 데이터나 성능을 주장하는 글이 아니라 OpenTelemetry 공식 문서를 바탕으로 한 학습용 정리입니다. 관측 데이터에는 요청 경로, 사용자 식별자, 쿼리 정보 같은 민감한 값이 포함될 수 있으므로 수집 범위와 마스킹 정책이 중요합니다.

<section class="quick-answers"><p class="quick-label">먼저 답하면</p><div class="quick-answer"><h3>Q. OpenTelemetry Collector는 모니터링 화면인가요?</h3><p>A. 아닙니다. 데이터를 수신·처리·전송하는 중계 계층입니다. Grafana, Prometheus, Jaeger, Datadog 같은 관측 백엔드가 데이터를 저장하고 조회·시각화하는 역할을 합니다.</p></div><div class="quick-answer"><h3>Q. SDK가 있는데 Collector가 왜 필요한가요?</h3><p>A. SDK는 애플리케이션에서 trace·metric·log를 만들고, Collector는 여러 데이터를 공통 방식으로 받으며 필터·배치·변환 후 목적지로 보낼 수 있습니다.</p></div><div class="quick-answer"><h3>Q. Collector 하나로 모든 장애를 찾을 수 있나요?</h3><p>A. 아닙니다. 데이터가 있어도 어떤 서비스 수준 목표를 볼지, 어떤 알람을 만들지, 로그의 민감 정보를 어떻게 처리할지는 별도로 설계해야 합니다.</p></div></section>

<figure class="article-figure"><img src="{{ '/assets/images/otel-collector-flow.svg' | relative_url }}" alt="OpenTelemetry Collector 데이터 파이프라인"><figcaption>이미지 출처: <a href="https://opentelemetry.io/docs/collector/architecture/">OpenTelemetry Collector Architecture</a>를 바탕으로 재구성 (CC BY 4.0)</figcaption></figure>

## 관측성의 세 신호: Trace·Metric·Log

관측성은 시스템 내부 상태를 외부에서 이해할 수 있게 만드는 능력입니다. 운영자가 “왜 느린가?”, “어느 서비스에서 오류가 났는가?”, “이 요청의 영향을 받은 사용자는 누구인가?”를 파악하려면 서로 다른 종류의 신호가 필요합니다.

Trace는 하나의 요청이 여러 시스템을 통과한 경로입니다. 사용자의 주문 요청이 API Gateway, 주문 서비스, 결제 서비스, PostgreSQL을 거쳤다면 각 구간의 시작·종료 시간과 관계를 연결합니다. Trace 안의 개별 작업 단위를 span이라고 부릅니다.

Metric은 시간에 따라 쌓이는 수치입니다. CPU 사용률, HTTP 요청 수, 오류율, p95 응답시간, DB 커넥션 수가 대표적입니다. Log는 특정 사건의 상세 기록입니다. 오류 메시지, 요청 ID, 예외 스택, 배포 버전처럼 원인을 더 깊게 확인할 단서를 남깁니다.

세 신호는 경쟁 관계가 아닙니다. 예를 들어 p95 지연시간 metric이 올라간 것을 먼저 감지하고, trace로 느린 서비스 구간을 찾고, 해당 서비스의 log로 예외와 쿼리 오류를 확인하는 식으로 함께 사용합니다.

## Collector는 어떤 위치에 있는가

애플리케이션이 OpenTelemetry SDK 또는 자동 계측을 통해 데이터를 만들면, Collector는 이를 받아 목적지로 전달할 수 있습니다. 공식 문서는 Collector가 vendor-agnostic 방식으로 telemetry를 receive, process, export한다고 설명합니다. 즉 애플리케이션이 특정 관측 제품에 직접 묶이는 부담을 줄이고, 중간에서 전송 정책을 관리할 수 있는 구조입니다.

```text
애플리케이션·서버·Kubernetes
        ↓
OpenTelemetry Collector
        ↓
Prometheus · Jaeger · Grafana · 상용 관측 플랫폼
```

Collector 자체는 하나의 바이너리 또는 컨테이너로 실행할 수 있습니다. Kubernetes에서는 모든 노드의 로그와 노드 수준 신호를 수집하는 DaemonSet, 애플리케이션 가까이에서 데이터를 받는 sidecar, 중앙에서 데이터를 처리하는 gateway 형태 등으로 배치할 수 있습니다. 어느 구조가 맞는지는 트래픽 양, 네트워크 경로, 장애 격리, 비용, 관리 방식에 따라 달라집니다.

## Receiver, Processor, Exporter를 이해하기

Collector 구성은 데이터 파이프라인으로 생각하면 쉽습니다.

| 구성 요소 | 역할 | 예시 |
| --- | --- | --- |
| Receiver | 데이터를 받아들임 | OTLP, Prometheus scrape, 파일 로그 |
| Processor | 필터·변환·배치 처리 | 민감 속성 제거, resource attribute 추가 |
| Exporter | 외부 시스템으로 전송 | OTLP backend, Prometheus remote write |
| Connector | 파이프라인 사이 연결 | trace에서 metric 생성 등 |
| Extension | 보조 기능 제공 | health check, 인증 관련 기능 |

Receiver는 데이터의 입구입니다. 애플리케이션이 OTLP 프로토콜로 trace를 보낼 수 있고, Prometheus Receiver가 특정 endpoint의 metric을 가져올 수도 있습니다. Processor는 중간 처리 단계입니다. 예를 들어 `user.email`처럼 민감할 수 있는 속성을 제거하거나, `environment=production` 같은 공통 속성을 추가하고, 작은 이벤트를 묶어 전송 횟수를 줄일 수 있습니다.

Exporter는 최종 목적지입니다. 개발 환경은 console exporter로 데이터 구조를 확인하고, 운영 환경은 조직이 쓰는 백엔드로 전송하는 식으로 구성할 수 있습니다. 하나의 Collector가 여러 exporter를 가질 수도 있지만, 모든 데이터를 모든 곳에 중복 전송하면 비용과 관리 부담이 커질 수 있습니다.

## 최소 구성 예시 읽기

아래는 OTLP로 받은 trace를 batch 처리한 뒤 logging exporter로 보내는 개념 예시입니다. 실제 운영에서는 Collector 배포판과 버전에 따라 컴포넌트 이름·설정이 다를 수 있습니다.

```yaml
receivers:
  otlp:
    protocols:
      grpc: {}

processors:
  batch: {}

exporters:
  debug: {}

service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [batch]
      exporters: [debug]
```

이 설정에서 애플리케이션은 OTLP gRPC로 trace를 Collector에 보냅니다. Collector는 batch processor로 일정 단위로 묶고, debug exporter로 출력합니다. 실습에는 이해하기 좋지만 production backend나 인증, 재시도, 메모리 제한, TLS 설정이 없으므로 그대로 운영에 사용하면 안 됩니다.

Kubernetes에서는 resource attribute를 잘 설계하는 것이 특히 중요합니다. `service.name`, `service.namespace`, `service.version`, `k8s.namespace.name`, `deployment.environment.name` 같은 속성이 일관되어야 서비스별 대시보드와 장애 분석이 쉬워집니다. OpenTelemetry Semantic Conventions는 이런 공통 이름을 정해 데이터 형식을 맞추도록 돕습니다.

## 왜 Collector를 중간에 둘까

첫째, 애플리케이션 설정을 단순하게 만들 수 있습니다. 여러 서비스가 각각 다른 백엔드 주소·인증 방식·샘플링 정책을 직접 알아야 한다면 설정 변경이 어렵습니다. Collector를 공통 종단점으로 두면 exporter 교체나 처리 정책을 중간에서 조정할 수 있습니다.

둘째, 데이터 품질과 비용을 관리하기 좋습니다. 모든 trace를 무제한 저장하면 비용이 커질 수 있고, 로그에 비밀번호나 토큰이 들어갈 위험도 있습니다. Collector processor에서 불필요한 속성을 제거하고, 특정 오류 trace를 우선 보존하며, batch와 retry를 조정하는 방식을 검토할 수 있습니다.

셋째, 장애 격리와 재시도를 설계할 수 있습니다. 관측 백엔드가 일시적으로 느려졌을 때 애플리케이션이 직접 영향을 받지 않도록 전송 경로를 분리할 수 있습니다. 하지만 Collector도 별도 운영 대상이 됩니다. 메모리 제한, 큐, retry, 수평 확장, Collector 자체의 metric과 log를 함께 모니터링해야 합니다.

## Kubernetes 배포 방식 비교

| 방식 | 어울리는 상황 | 주의할 점 |
| --- | --- | --- |
| DaemonSet | 노드·컨테이너 로그, 노드 가까운 수집 | 노드별 자원 사용과 권한 |
| Sidecar | 애플리케이션별 격리와 근접 수집 | Pod 수만큼 운영 부담 증가 |
| Gateway | 중앙 처리, exporter·샘플링 통합 | 단일 병목과 확장·가용성 설계 |

한 방식만 고집할 필요는 없습니다. 예를 들어 DaemonSet Collector가 노드의 로그를 받고, 중앙 Gateway Collector가 여러 팀의 OTLP 데이터를 처리하는 조합도 가능할 수 있습니다. 다만 구조가 복잡해질수록 데이터가 어느 Collector에서 변환·삭제·전송되는지 추적하기 어려워지므로, 처음에는 한 가지 명확한 파이프라인부터 시작하는 편이 좋습니다.

## 운영 전에 확인할 것

가장 먼저 수집 목적을 정해야 합니다. “모든 데이터를 모은다”는 목표는 비용과 민감정보 문제를 만들 수 있습니다. 서비스 장애 분석이 목표라면 핵심 API의 오류율·지연시간·trace context부터 수집하고, 필요한 로그와 DB metric을 단계적으로 늘리는 방식이 현실적입니다.

또한 Collector의 실패를 관측해야 합니다. queue가 쌓이는지, exporter 실패가 늘어나는지, 메모리 제한으로 데이터가 드롭되는지 확인하지 않으면 “관측 시스템이 장애를 놓치는 장애”가 생길 수 있습니다. Collector의 자체 health check와 내부 metric을 대시보드·알람에 포함하는 것이 좋습니다.

마지막으로 데이터 거버넌스가 필요합니다. SQL 전체 문장, HTTP header, 사용자 ID는 민감할 수 있습니다. 개발 환경에서 편리했던 상세 속성을 운영에 그대로 보내기보다, 수집 허용 목록·마스킹·보존 기간·접근 권한을 정해야 합니다.

<section class="quick-answers"><p class="quick-label">한계와 적용 기준</p><div class="quick-answer"><h3>Q. Collector가 있으면 애플리케이션에 SDK를 넣지 않아도 되나요?</h3><p>A. 일부 자동 계측과 인프라 수집은 가능하지만, 결제 승인이나 주문 생성처럼 업무 의미가 있는 span은 SDK나 코드 기반 계측이 더 정확할 수 있습니다. Collector와 SDK는 보완 관계입니다.</p></div><div class="quick-answer"><h3>Q. 모든 로그를 Collector로 보내면 되나요?</h3><p>A. 아닙니다. 로그량·비용·개인정보를 고려해야 합니다. 장애 분석에 필요한 구조화된 로그와 보존 정책을 먼저 정하고, 불필요한 원문·민감 속성은 줄이는 편이 좋습니다.</p></div><div class="quick-answer"><h3>Q. 관측 백엔드를 바꾸면 설정이 전혀 안 바뀌나요?</h3><p>A. 애플리케이션 변경을 줄일 수는 있지만 exporter, 인증, 데이터 모델, 대시보드·알람은 검토해야 합니다. Collector가 모든 이식성 문제를 제거하는 것은 아닙니다.</p></div></section>

OpenTelemetry Collector는 관측 데이터를 수집하는 애플리케이션과 데이터를 보는 백엔드 사이를 연결하는 운영 계층입니다. 취준생이라면 Trace·Metric·Log의 차이, Receiver·Processor·Exporter의 역할, Kubernetes에서의 배포 방식부터 이해하면 충분합니다. 이후에는 실제 서비스의 장애 질문 하나를 정하고, 어떤 신호를 어디에서 수집할지 설계해 보면 개념이 더 선명해집니다.

<h3 class="references-heading">참고 자료</h3>

- [OpenTelemetry Collector Components](https://opentelemetry.io/docs/collector/components/)
- [OpenTelemetry Collector Quick Start](https://opentelemetry.io/docs/collector/quick-start/)
- [OpenTelemetry Collector와 Kubernetes](https://opentelemetry.io/docs/platforms/kubernetes/collector/)
- [OpenTelemetry Semantic Conventions](https://opentelemetry.io/docs/concepts/semantic-conventions/)
- [OpenTelemetry Collector Distributions](https://opentelemetry.io/docs/collector/distributions/)
