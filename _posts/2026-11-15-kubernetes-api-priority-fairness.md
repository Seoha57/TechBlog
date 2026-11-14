---
layout: post
title: "Kubernetes API 서버를 지키는 법: API Priority and Fairness로 요청 우선순위와 공정성 설계하기"
categories: [Infrastructure]
tags: [infrastructure, kubernetes, api-server, apf, reliability, control-plane]
description: "Kubernetes API Priority and Fairness의 FlowSchema·PriorityLevelConfiguration·좌석과 큐 동작을 이해하고, 제어면 과부하에서 중요한 요청을 지키는 설계와 점검 방법을 정리합니다."
---

## 먼저 답하기

### Q. Kubernetes API Priority and Fairness는 애플리케이션 API의 속도를 높이는 기능인가요?

A. 아니다. Kubernetes API Priority and Fairness(APF)는 Kubernetes API 서버로 들어오는 요청을 분류하고, 혼잡할 때 어떤 요청을 먼저 처리하고 어떤 요청을 대기열에 둘지 정하는 제어면 기능이다. 고객이 호출하는 주문 API의 응답 시간을 직접 개선하는 장치는 아니다. 대신 컨트롤러, kubelet, 운영자, 배포 도구가 동시에 API 서버를 많이 호출해도 노드 상태 보고나 핵심 제어 루프 같은 요청이 덜 밀리게 해 클러스터가 회복할 여지를 지킨다.

### Q. 작은 클러스터에도 APF가 필요한가요?

A. 무조건 사용자 정의 정책을 만들 필요는 없다. Kubernetes는 기본 PriorityLevelConfiguration과 FlowSchema를 제공하므로, 처음에는 기본 분류가 실제 요청 특성과 맞는지 관찰하는 편이 낫다. 다만 CI/CD(Continuous Integration and Continuous Delivery, 코드 변경을 자동으로 통합·배포하는 방식)가 많은 리소스를 반복 조회하거나, 여러 테넌트가 하나의 API 서버를 공유하거나, 장애 조사 스크립트가 목록 조회를 폭증시키는 환경이라면 요청 경계를 설계할 이유가 생긴다. 중요한 원칙은 "빠른 팀"에 높은 우선순위를 주는 것이 아니라, 제어면이 망가질 때도 복구와 안전에 필요한 요청을 남기는 것이다.

## 먼저 알아둘 기반 기술

### Kubernetes API 서버와 제어면

Kubernetes는 선언한 desired state, 즉 원하는 상태를 실제 상태로 맞추는 시스템이다. 사용자가 `kubectl apply`를 실행하거나 Deployment를 만드는 일, kubelet이 Pod 상태를 보고하는 일, controller가 ReplicaSet을 조정하는 일은 모두 Kubernetes API 서버를 거친다. API 서버는 인증(authentication), 인가(authorization), admission, 객체 읽기·쓰기와 watch 연결을 처리하는 제어면(control plane)의 관문이다.

여기서 중요한 점은 API 서버가 단순한 데이터베이스 프록시가 아니라는 사실이다. 인증서 검증, Role-Based Access Control(RBAC, 역할에 따라 Kubernetes API 권한을 부여하는 모델), admission webhook 호출, 객체 변환, etcd 읽기·쓰기, watch 이벤트 전달이 한 요청 경로에 섞일 수 있다. 따라서 대량 조회가 늘거나 느린 webhook이 생기면 "배포 명령 하나"만 늦어지는 것이 아니라 스케줄러·컨트롤러·노드 보고까지 영향을 받을 수 있다.

### 동시성, 큐, 좌석이라는 세 가지 단어

APF를 읽을 때는 request, queue, seat를 구분하면 이해가 쉽다. 요청(request)은 API 서버에 들어온 한 번의 HTTP 호출이다. 큐(queue)는 지금 바로 처리할 수 없는 요청이 잠시 기다리는 줄이다. 좌석(seat)은 APF가 요청 처리에 배정하는 동시성 단위다. 일반적인 요청은 보통 하나의 좌석을 사용하지만, 목록 조회처럼 응답 객체가 매우 큰 요청은 처리 중 더 많은 좌석을 쓸 수 있다. 좌석은 사용자 계정이 차지하는 물리 CPU가 아니라 API 서버의 과부하를 막기 위한 논리적 처리 예산이다.

제한 없이 모든 요청을 동시에 실행하면, 가장 많은 요청을 보내는 주체가 API 서버의 처리 시간과 연결을 사실상 독점할 수 있다. 반대로 모든 요청을 하나의 긴 줄에 세우면 kubelet heartbeat나 system controller가 대량 배포 작업 뒤에 갇힐 수 있다. APF는 요청 유형별 예산과 대기열을 나누어 이 두 극단을 피하려는 장치다.

### API Priority and Fairness의 구성 요소

APF는 크게 FlowSchema와 PriorityLevelConfiguration이라는 두 Kubernetes 리소스로 구성된다. FlowSchema는 들어온 요청을 어떤 기준으로 분류할지 적는다. 사용자 이름, 그룹, namespace, resource, verb 같은 조건을 사용해 "이 요청은 어느 priority level로 보낼 것인가"를 결정한다. 여러 FlowSchema가 맞으면 `matchingPrecedence`가 더 작은 것이 먼저 선택되므로, 넓은 규칙보다 구체적 규칙의 우선순위를 의도적으로 관리해야 한다.

PriorityLevelConfiguration은 분류된 요청이 실제로 어떤 예산과 대기 방식을 쓸지 정한다. `limited` 유형은 동시 실행 예산과 대기열 설정을 가지며, 과부하 때 요청을 큐에 넣거나 거절할 수 있다. `exempt` 유형은 일반적인 제한을 받지 않는 예외 경로다. exempt는 "가장 중요한 사용자"의 특권이 아니라, 제한하면 제어면의 기본 동작 자체가 위험해질 수 있는 시스템 요청을 위한 좁은 통로로 다뤄야 한다.

### 기본 정책을 먼저 읽어야 하는 이유

처음 APF를 도입할 때 가장 흔한 실수는 새 FlowSchema를 바로 많이 만드는 것이다. 기본 구성에는 `system` 성격의 요청, leader election, node 관리, catch-all 요청 등을 나누는 정책이 이미 존재한다. 자신이 만든 넓은 규칙이 예상하지 못한 controller 요청까지 잡으면, 보호하려던 시스템을 오히려 낮은 우선순위 큐에 넣을 수 있다. 그래서 시작은 `kubectl get flowschemas`와 `kubectl get prioritylevelconfigurations`로 현재 정책을 읽고, audit log·메트릭·인증 주체를 함께 확인하는 일이다.

```bash
kubectl get flowschemas.flowcontrol.apiserver.k8s.io
kubectl get prioritylevelconfigurations.flowcontrol.apiserver.k8s.io
kubectl describe flowschema catch-all
kubectl describe prioritylevelconfiguration workload-low
```

명령이 성공했다고 정책이 맞다는 뜻은 아니다. describe 결과에서 어떤 subjects, resource rules, precedence, priority level이 연결되는지를 읽어야 한다. 관리형 Kubernetes에서는 control plane 플래그나 메트릭 접근 범위가 제한될 수 있으므로, 제공자가 사용자 정의 APF 리소스를 허용하는지도 문서로 확인한다.

## 왜 이 기능이 등장했는가: API 서버 혼잡이 만드는 연쇄 실패

예를 들어 월말 정산 배포가 있는 날을 생각해 보자. 여러 pipeline이 동시에 namespace의 Job, Pod, ConfigMap을 목록 조회하고, 자체 운영 도구도 모든 cluster object를 주기적으로 수집한다. 동시에 한 노드가 네트워크 문제로 재등록을 반복하고, controller manager는 준비되지 않은 Pod를 다시 조정한다. 겉으로는 배포 팀의 `kubectl get pods -A`가 느려진 문제처럼 보일 수 있다. 그러나 API 서버가 충분히 처리하지 못하면 node lease 갱신, controller의 reconciliation, scheduler의 binding도 밀릴 수 있다.

기존에는 API 서버의 최대 inflight 요청 수를 전역으로 제한하는 방식이 주로 사용됐다. 이 방식은 전체 폭주를 막는 데 도움이 되지만, 서로 다른 요청의 중요도를 표현하기 어렵다. 사내 대시보드의 반복 list 요청과 cluster 안정성에 필요한 요청이 같은 문 앞에서 같은 제한을 공유할 수 있기 때문이다. APF는 요청을 분류하고, 각 분류에 동시성 비율과 공정한 대기열을 두어 한 흐름의 과도한 사용이 다른 흐름을 완전히 삼키지 않도록 한다.

여기서 "공정성"은 모든 요청의 대기 시간이 같다는 뜻이 아니다. 우선순위 level끼리는 미리 정한 예산을 따르고, 같은 level 안에서는 사용자·namespace·서비스 계정 같은 식별자를 기준으로 flow를 나눠 한 흐름이 큐를 독점하지 않게 한다. 운영자가 해야 할 일은 어떤 단위가 서로 공정해야 하는지 정의하는 것이다. 예를 들어 외부 고객사가 공유하는 cluster라면 tenant namespace 단위가 의미 있을 수 있고, 내부 cluster라면 CI 서비스 계정과 사람이 쓰는 kubectl 계정을 분리하는 쪽이 더 실용적일 수 있다.

## FlowSchema를 업무 요청으로 번역하는 방법

### 1. 요청을 사람, 자동화, 시스템으로 나눈다

정책을 쓰기 전에 API 서버에 누가 들어오는지 목록을 만든다. 대체로 다음 세 부류가 있다.

| 부류 | 예시 | 설계에서 확인할 질문 |
| --- | --- | --- |
| 시스템 | kubelet, controller, scheduler, cloud controller | 지연되면 cluster 복구·상태 갱신이 막히는가? |
| 자동화 | GitHub Actions, Argo CD, Terraform, 정기 수집 Job | 요청량의 상한과 재시도 정책이 있는가? |
| 사람과 도구 | 운영자 kubectl, 대시보드, 장애 조사 스크립트 | 긴 목록 조회·watch를 누가 실행하는가? |

이 표는 계정 이름만 나열하는 문서가 아니다. 서비스 계정이 실제로 어떤 API verb를 어떤 빈도로 호출하는지, 실패 때 얼마나 빨리 재시도하는지, 무거운 `list`와 `watch`를 하는지까지 적어야 한다. 작업을 자동화했다는 이유만으로 모두 낮은 우선순위에 두면, 긴급 rollback 자동화도 같이 늦어질 수 있다. 반대로 모든 CI를 높은 level로 두면 APF를 만들어도 보호 효과가 없다.

### 2. 너무 넓은 규칙 대신 한 가지 위험을 겨냥한다

다음 예시는 보고용 inventory exporter가 cluster 전체 객체를 주기적으로 읽는 경우를 낮은 우선순위 level로 보낼 수 있는 출발점이다. 이름은 예시이며, 실제 사용자·그룹·리소스는 audit 기록과 RBAC 정의에 맞춰야 한다.

```yaml
apiVersion: flowcontrol.apiserver.k8s.io/v1
kind: FlowSchema
metadata:
  name: inventory-exporter-readonly
spec:
  matchingPrecedence: 9000
  priorityLevelConfiguration:
    name: workload-background
  distinguisherMethod:
    type: ByUser
  rules:
    - subjects:
        - kind: ServiceAccount
          serviceAccount:
            namespace: platform-observability
            name: inventory-exporter
      resourceRules:
        - apiGroups: ["*"]
          resources: ["*"]
          verbs: ["list", "watch"]
          clusterScope: true
          namespace: ""
```

이 예시의 핵심은 모든 읽기 요청을 낮추는 것이 아니라, 식별된 한 서비스 계정의 cluster-scope 목록·watch 요청만 겨냥했다는 점이다. `ByUser`는 같은 priority level 안에서 사용자별로 흐름을 나눌 때 사용할 수 있다. 하지만 서비스 계정 하나를 여러 Job이 공유하면 서로 다른 작업도 같은 흐름으로 묶인다. 공정성 단위와 credential 설계는 분리할 수 없는 문제다.

### 3. PriorityLevelConfiguration의 비율을 숫자 놀음으로 보지 않는다

limited priority level은 `assuredConcurrencyShares`처럼 서버 동시성 예산을 나누는 설정과 큐 설정을 가진다. 숫자를 크게 쓰면 중요도가 높아지는 듯 보이지만, 총합 안에서 상대적 비율로 해석해야 하며 API 서버의 실제 용량, 다른 level, 요청 비용이 함께 작동한다. 값 하나를 올려 배포 속도를 해결하려 하지 말고, 먼저 해당 흐름이 정말 필요 이상의 요청을 만들고 있지는 않은지 점검한다.

```yaml
apiVersion: flowcontrol.apiserver.k8s.io/v1
kind: PriorityLevelConfiguration
metadata:
  name: workload-background
spec:
  type: Limited
  limited:
    assuredConcurrencyShares: 10
    limitResponse:
      type: Queue
      queuing:
        queues: 16
        handSize: 4
        queueLengthLimit: 50
    lendablePercent: 0
    borrowingLimitPercent: 0
```

`queues`, `handSize`, `queueLengthLimit`은 단순히 크게 할수록 좋은 파라미터가 아니다. 큐가 너무 길면 요청을 즉시 실패시키는 대신 오래 기다리게 만들어 caller timeout과 재시도를 키울 수 있다. 큐가 너무 짧으면 작은 순간적 burst도 거절한다. 여러 queue와 hand 선택은 flow를 분산해 한 주체의 queue 독점을 줄이려는 장치다. 특정 숫자를 복사하기보다, 해당 자동화가 실패를 어떻게 처리하는지와 사용자에게 허용 가능한 대기 시간을 먼저 정해야 한다.

## 동작을 한 번의 요청 흐름으로 따라가기

1. 클라이언트가 API 서버로 요청을 보낸다. TLS, 인증, 인가 같은 앞단 절차를 거친다.
2. API 서버는 FlowSchema 규칙을 위에서부터 비교해 가장 우선되는 일치 규칙을 고른다.
3. 선택된 FlowSchema가 가리키는 PriorityLevelConfiguration을 확인한다. exempt면 일반 제한을 거치지 않고, limited면 사용 가능한 좌석을 본다.
4. 좌석이 있으면 요청을 실행한다. 없으면 distinguisher가 만든 flow와 큐 선택 규칙에 따라 기다린다.
5. 큐 길이 한도를 넘거나 기다릴 수 없으면 API 서버는 요청을 거절할 수 있다. 클라이언트는 이 응답을 무한 재시도 신호로 해석하면 안 된다.
6. 요청이 끝나면 좌석이 반환되고, 대기 중인 요청이 다음 처리 기회를 얻는다.

이 흐름에서 APF는 요청의 의미를 알지 못한다. `POST /deploy`가 고객에게 중요한지, `LIST /pods`가 장애 조사인지 구분하는 것은 FlowSchema 조건과 인증 주체, resource rule을 설계한 사람의 책임이다. 그래서 "운영자면 높게" 같은 규칙은 위험하다. 사람의 계정이 자동화에 사용되거나, 운영자 계정이 대량 스크립트를 실행하면 정책의 의도와 실제 트래픽이 달라질 수 있다.

## 구체적인 업무 예시: 야간 배포와 inventory 수집이 충돌할 때

가상의 전자상거래 platform 팀이 있다. GitOps controller는 매일 밤 여러 namespace에 manifest를 적용하고, security inventory Job은 모든 namespace의 Secret metadata와 workload label을 수집한다. 어느 날 inventory exporter의 pagination 구현이 빠져 매번 큰 list를 반복하고, 실패하면 즉시 재시도한다. GitOps controller의 apply 요청과 controller reconciliation이 간헐적으로 느려지자 팀은 "API 서버 CPU를 올리자"고 생각한다.

이 상황에서 점검 순서는 다음과 같다. 첫째, exporter의 사용자와 호출 resource·verb·주기를 확인한다. 둘째, pagination, resourceVersion 사용, backoff, 동시 worker 수를 고친다. APF는 비효율적인 client를 정당화하는 수단이 아니다. 셋째, exporter가 꼭 cluster-wide watch를 유지해야 하는지, namespace별 scope나 이벤트 기반 전달로 줄일 수 있는지 검토한다. 넷째, 개선 뒤에도 일시적 burst가 controller 요청에 영향을 준다면 exporter 전용 FlowSchema와 제한된 priority level을 좁게 적용한다.

배포 시간에는 다음 관찰표를 준비할 수 있다.

| 관찰 대상 | 왜 보는가 | 기준을 넘으면 먼저 할 일 |
| --- | --- | --- |
| API 요청 거절·대기 | 특정 level이 과부하인지 확인 | caller 재시도와 동시성 제한을 확인 |
| API 서버 지연·오류 | 제어면 전체 영향 확인 | webhook, etcd, 연결 수를 함께 점검 |
| GitOps apply 실패 | 배포 경로가 낮은 level에 갇혔는지 확인 | FlowSchema match와 서비스 계정 확인 |
| node·controller 상태 갱신 | cluster 복구 경로 보호 확인 | system 규칙을 침범하지 않았는지 확인 |

여기서 "모든 요청이 성공해야 한다"는 목표는 현실적이지 않다. background inventory는 혼잡 시 늦어지거나 일부 재시도될 수 있다. 대신 주문 서비스의 scheduling, 노드 상태 갱신, rollback에 필요한 경로가 함께 무너지는 일을 피하는 것이 목표다. 영향도에 따라 실패 허용도를 다르게 정하는 것이 우선순위 설계다.

## APF와 다른 보호 장치의 경계

APF가 있다고 해서 API 서버 성능 문제의 원인이 사라지지는 않는다. 다음 도구들은 서로 다른 층을 다룬다.

| 도구 또는 방법 | 주로 해결하는 문제 | APF를 대신할 수 없는 이유 |
| --- | --- | --- |
| RBAC | 누가 어떤 API를 호출할 수 있는가 | 허용된 주체의 과도한 호출량은 제한하지 않는다 |
| ResourceQuota·LimitRange | namespace의 Pod 자원 소비 | API 서버 요청 동시성과 큐를 제어하지 않는다 |
| client-side rate limit·backoff | 호출자가 보내는 속도와 재시도 | 여러 caller 사이의 공정한 처리 순서를 보장하지 않는다 |
| API 서버 확장·etcd 튜닝 | 전체 처리 능력 | 혼잡 시 어떤 요청을 보호할지 결정하지 않는다 |
| admission policy | 생성·수정 요청의 허용 조건 | 읽기·watch 폭주나 큐 경쟁을 해결하지 않는다 |

가장 먼저 적용할 것은 대개 client-side rate limit과 exponential backoff다. APF가 큐에 넣은 요청을 클라이언트가 timeout 직후 여러 번 다시 보내면 대기열을 더 악화시킬 수 있다. `Retry-After` 같은 서버 신호, idempotency, jitter를 이해하고, 자동화의 최대 동시성을 명시해야 한다. 특히 `list`·`watch`를 반복하는 운영 도구는 cache나 informer 사용 여부도 점검한다.

## 관찰 가능한 정책으로 만들기

APF는 manifest를 적용하는 순간 끝나는 기능이 아니다. 우선순위를 바꾸면 요청이 어디에서 기다리고 왜 거절됐는지를 읽을 수 있어야 한다. API server가 노출하는 메트릭 이름과 범위는 Kubernetes 버전·배포 방식에 따라 달라질 수 있지만, 운영 관점에서는 세 층을 함께 관찰하는 것이 유용하다. 첫째는 API server 전체의 요청량, 지연, HTTP 오류다. 둘째는 priority level별 실행·대기·거절 신호다. 셋째는 그 API를 호출한 client의 재시도와 실제 업무 결과다.

가령 낮은 우선순위 exporter의 큐 길이가 늘었다고 하자. 이것만 보고 shares를 올리면 안 된다. 같은 시간에 exporter가 release를 무시하고 새 worker를 무한히 만들었는지, 호출 대상이 한 번 읽으면 되는 객체를 반복 list했는지, client timeout이 큐에서 정상적으로 기다리는 요청을 실패로 오인했는지를 먼저 본다. 반대로 API server의 전체 지연은 낮은데 GitOps만 timeout이라면 FlowSchema가 예상과 다른 level에 match했거나 GitOps client의 request timeout이 지나치게 짧을 수 있다.

### 요청을 추적할 때 남겨야 할 정보

각 자동화에는 사람이 읽을 수 있는 이름만 아니라 안정적인 service account와 request 식별자를 두는 편이 좋다. CI pipeline의 run ID, GitOps sync revision, exporter snapshot ID를 로그에 남기면, API server 대기와 업무 작업의 지연을 연결할 수 있다. 단, API audit log에 Secret 본문이나 고객 데이터가 과도하게 남지 않도록 audit policy와 접근 권한을 함께 점검해야 한다. 관찰성을 늘리려다 더 민감한 정보를 넓게 보관해서는 안 된다.

아래처럼 요청 흐름을 한 줄로 표현하면 장애 회의에서 원인과 영향을 분리하는 데 도움이 된다.

```text
sync-20261115-0420
  -> argocd-application-controller service account
  -> PATCH deployments.apps / namespace shop
  -> FlowSchema: gitops-write
  -> PriorityLevel: workload-interactive
  -> API response / retry attempt / rollout result
```

이 기록은 APF가 실제로 "누구를 우대했는가"를 사후에 확인하게 한다. FlowSchema 이름만 보고는 모든 match를 알 수 없기 때문이다. 특히 group 기반 규칙은 미래에 새 service account가 그 group에 추가됐을 때도 영향을 받는다. 정책 변경 review에는 현재 match 대상뿐 아니라, 앞으로 확장될 수 있는 group·wildcard·cluster-scope resource를 같이 적는다.

### 경고 기준은 혼잡과 장애를 구분해야 한다

한두 번의 queue 대기는 실패가 아닐 수 있다. batch성 작업에는 일정 범위의 대기가 정상일 수 있다. 경고는 특정 priority level의 대기 또는 거절이 지속되고, 동시에 API server 오류율·컨트롤러 backlog·배포 실패 같은 업무 영향이 동반될 때 의미가 커진다. 반대로 system 요청의 지연이 관찰되면 낮은 priority level만 보는 것으로 충분하지 않다. control plane 전체 health, etcd 응답, admission webhook, 네트워크와 인증 시스템까지 확대해서 조사해야 한다.

경고 문구도 행동 가능해야 한다. "APF queue high" 대신 "inventory-exporter가 workload-background에서 10분간 거절됨: 새 export 제출 중지, exporter concurrency 확인, GitOps sync 결과 확인"처럼 대상과 첫 행동을 포함한다. 이 문구는 운영자에게 책임을 떠넘기는 설명이 아니라, 과거에 합의한 우선순위 정책을 실제 대응으로 연결하는 runbook의 일부다.

## FlowSchema를 테스트하는 방법

### 선언 파일 검토

YAML은 문법적으로 유효해도 의도한 요청을 match하지 않을 수 있다. `subjects`의 ServiceAccount namespace·name이 실제 credential과 맞는지, `resourceRules`의 `apiGroups`와 `resources`가 API path와 맞는지, `clusterScope`와 `namespaces`를 함께 쓸 때 범위가 정확한지 확인한다. `verbs: ["*"]`나 `resources: ["*"]`는 처음에는 편하지만 새 CRD와 향후 요청까지 포괄할 수 있으므로, 좁은 문제를 해결하는 규칙에는 가급적 피한다.

예를 들어 exporter가 Pod와 Deployment의 metadata만 읽는다면, 모든 resource의 watch를 허용하는 규칙 대신 필요한 group과 resource를 명시하는 것이 안전하다. CRD 목록 조회가 필요한지, Secret metadata는 왜 필요한지, namespace를 건너는 조회가 필요한지 한 항목씩 질문하면 규칙이 짧아지고 rollback 영향도 줄어든다. 권한 최소화는 RBAC만의 일이 아니라 API traffic 분류에서도 효과가 있다.

### 대표 요청 검증

test cluster에서 대상 service account의 토큰 또는 impersonation으로 실제 요청을 발생시키고, 해당 요청이 예상 level로 분류되는지 관찰한다. production system 계정을 직접 흉내 내기 어렵다면, 같은 rule만 만족하는 전용 test service account와 좁은 namespace를 만든다. 이 검증은 unit test처럼 FlowSchema 객체만 비교하는 것보다 낫다. 실제 client library가 호출하는 resource path, 추가 query parameter, watch 연결의 행동을 함께 볼 수 있기 때문이다.

테스트에는 정상 요청만 넣지 않는다. 짧은 burst, 긴 watch, permission denied, API server가 일시적으로 느린 상황도 넣는다. 목적은 API 서버를 과부하시키는 것이 아니라 client가 큐잉·거절을 만났을 때 backoff하고 operator가 원인을 읽을 수 있는지 확인하는 것이다. 시험을 위해 동시성을 올릴 때도 test environment capacity와 다른 팀의 영향을 먼저 확인한다.

### 변경 전후 비교

정책을 바꾼 뒤 비교할 수 있도록 다음 항목을 같은 형식으로 남긴다. background 작업의 완료 시간, 요청 거절 수, retry 횟수, GitOps apply 성공률, controller reconciliation 지연, node ready 변화, API server 지연이다. 특정 숫자 하나가 좋아졌다고 성공이라고 판단하지 말고, 보호하려던 interactive·system 경로가 실제로 더 안정적이었는지 본다. background 작업이 약간 오래 걸리더라도 다른 중요한 경로가 보호됐다면 정책 목적에는 맞을 수 있다.

## 흔한 실패 패턴과 바로잡는 방법

### 실패 패턴 1: 높은 우선순위를 성능 등급으로 취급한다

팀마다 자신의 automation이 중요하다고 주장하면 결국 거의 모든 요청이 high priority가 된다. 그러면 제한된 예산을 나누는 의미가 없어진다. 우선순위는 팀의 조직적 위상이 아니라, 그 요청이 늦어졌을 때 제어면 복구와 고객 영향에 어떤 결과가 생기는지로 정한다. nightly report가 늦는 것과 node heartbeat가 늦는 것은 같은 문제가 아니다.

### 실패 패턴 2: API 오류를 APF 하나로 설명한다

인증 문제, certificate 만료, webhook timeout, etcd compaction, DNS 장애, control plane resource pressure는 모두 API 오류처럼 보일 수 있다. APF 대기나 거절이 보인다고 해서 최초 원인이 client burst라는 결론을 내리지 않는다. 시간 순서, API server component log, etcd health, 외부 webhook dependency, 최근 manifest 변경을 함께 확인한다. APF는 증상 완화와 격리에 도움을 주지만 root cause 분석을 대체하지 않는다.

### 실패 패턴 3: 큐를 길게 하면 안정적이라고 믿는다

긴 큐는 거절 수를 잠시 줄여 보일 수 있지만, 호출자는 더 오래 기다리고 deadline을 넘길 수 있다. timeout 뒤 재시도가 들어오면 원래 큐에 남은 요청과 새 요청이 동시에 존재해 부하가 커진다. 사용자에게 결과가 필요 없는 background 작업은 긴 대기를 허용할 수 있지만, 배포·복구 경로는 caller timeout과 큐 대기 예산을 함께 정해야 한다. 대기 시간을 숨기는 대신 실패를 늦추는 정책은 좋은 정책이 아니다.

### 실패 패턴 4: 정책과 client 변경을 따로 배포한다

API priority level을 낮추면서 client concurrency와 retry를 그대로 두면 예상보다 큰 queue가 생길 수 있다. 반대로 client 개선만 먼저 하면 APF가 필요 없어진다는 사실을 발견할 수도 있다. FlowSchema, client rate limit, dashboards, rollback runbook을 하나의 변경 묶음으로 review하고, 누가 어느 순서로 되돌릴 수 있는지 명시한다.

## 여러 팀이 공유하는 클러스터에서의 운영 원칙

공유 cluster의 APF는 기술 설정이면서 테넌트 간 약속이다. 플랫폼 팀이 한 tenant의 background 작업을 낮은 priority level에 넣었을 때, 그 팀은 "우리만 느려졌다"고 느낄 수 있다. 따라서 정책을 적용하기 전부터 어떤 작업이 혼잡 시 지연될 수 있는지, interactive 배포와 nightly report의 상대적 목표가 무엇인지 공개해야 한다. 요청을 제한하는 이유는 특정 팀을 벌주기 위해서가 아니라, 한 테넌트의 burst가 다른 서비스와 control plane 복구를 멈추게 하지 않기 위해서다.

네임스페이스만으로 공정성을 정의해도 충분하지 않을 수 있다. 큰 조직은 하나의 namespace에서 여러 controller와 batch Job을 실행할 수 있고, 반대로 작은 서비스는 여러 namespace를 쓸 수 있다. `ByNamespace`와 `ByUser` 중 어느 distinguisher가 더 공정한지는 조직의 credential·namespace 모델에 따라 다르다. 처음에는 실제 혼잡의 원인이 service account별인지 namespace별인지 로그로 확인하고, 사용자가 아무나 새 namespace를 만들 수 있는 환경에서는 label이나 namespace 수만으로 quota를 우회할 수 없는지도 본다.

### 예외 요청을 처리하는 절차

새로운 automation이 더 높은 priority를 요청하면, "중요하다"는 말만으로 승인하지 않는다. 담당자는 다음 네 질문에 답한다. 이 요청이 늦으면 어떤 고객·제어면 영향이 생기는가? 평균과 burst 요청량은 어느 정도인가? caller는 rate limit과 exponential backoff를 사용하는가? limited level로 해결할 수 없는 이유는 무엇인가? 답이 없는 경우에는 기본 level에서 제한된 pilot을 먼저 실행한다. 이 절차는 ticket 하나를 늘리기 위한 형식이 아니라 exempt나 high share 설정이 시간이 지나 무분별하게 늘어나는 것을 막는 장치다.

정책 소유자도 명확히 한다. FlowSchema를 만든 팀이 사라지고 service account만 남으면, 나중에 broad match가 새 workload를 잡아도 누구도 이유를 모른다. 각 사용자 정의 policy에는 owner, 목적, 적용한 client, 검토일, 제거 조건을 annotation 또는 별도 문서에 적는다. background exporter가 폐기되면 FlowSchema와 PriorityLevelConfiguration도 같이 정리한다. 사용하지 않는 높은 우선순위 규칙은 미래의 API traffic을 예측하기 어렵게 만든다.

### incident 중 바꾸지 말아야 할 것

API server가 이미 심각하게 혼잡한 incident에서 여러 priority level의 shares와 queue 길이를 동시에 바꾸는 것은 위험하다. 한 번에 여러 변수를 조정하면 어떤 변경이 회복에 도움이 됐는지 알 수 없고, system 요청까지 예상 밖 경로로 보낼 수 있다. 먼저 burst를 만드는 client를 중지하거나 concurrency를 낮추고, API server·etcd·webhook 상태를 안정화한다. 정책 변경이 꼭 필요하다면 사전에 준비한 rollback manifest와 좁은 한 변경을 사용하고, 직후 영향 지표를 관찰한다.

incident가 끝난 뒤에는 어떤 요청이 어느 FlowSchema에 match했는지, client가 어떤 재시도를 했는지, queue와 거절이 업무에 어떤 영향을 줬는지를 timeline으로 남긴다. 그 기록은 다음 APF 정책을 위한 최고의 입력이다. 사후 분석의 결론이 "shares를 더 높인다" 하나로 끝난다면, 호출량·권한·retry·관찰성 중 더 근본적인 원인을 놓쳤을 가능성이 크다.

## 점진 적용 절차

### 1. 변경 전 기준선을 남긴다

APF 설정을 바꾸기 전에는 API 서버 요청의 주체·verb·resource·응답 코드·지연을 볼 수 있는 위치를 찾는다. audit log가 있다면 requestURI와 user 정보를, 메트릭이 있다면 flow control 관련 지표와 API server request 지표를 확인한다. 관리형 환경에서 control plane 로그가 제공되지 않으면, CI 로그·GitOps controller 메트릭·클라이언트 오류부터 모아도 된다. 중요한 것은 "느리다"라는 인상을 특정 요청 패턴과 시간대로 연결하는 것이다.

### 2. 낮은 위험 흐름 하나만 분리한다

처음부터 human, CI, controller, system을 모두 새 level로 나누지 않는다. 영향이 비교적 낮고 식별이 쉬운 background exporter 하나를 선택한다. FlowSchema의 `matchingPrecedence`를 기존 넓은 규칙보다 의도적으로 앞에 두되, system group이나 kubelet 계정까지 match하지 않는지 manifest를 사람 두 명이 함께 검토한다. 이때 `kubectl auth can-i`는 권한 확인에는 좋지만 APF match를 검증하는 도구는 아니므로, 실제 test cluster 요청과 관찰을 병행한다.

### 3. 실패 경로를 의도적으로 확인한다

테스트 환경에서 exporter의 worker 수를 제한 범위보다 높게 늘리거나, 긴 목록 조회를 만드는 상황을 안전한 범위에서 재현한다. 이때 확인할 것은 exporter가 느려졌는지뿐 아니라, GitOps·controller·node 상태 경로가 계속 동작하는지다. 큐가 찼을 때 exporter가 계속 즉시 retry하지 않고 backoff하는지, 로그가 "권한 없음"과 "일시적 혼잡"을 구별하는지도 확인한다.

### 4. rollback은 manifest 삭제가 아니라 영향 복구 계획이다

문제가 생겼을 때 FlowSchema를 삭제하면 요청이 다른 기본 규칙으로 흘러간다. 따라서 rollback 뒤 어떤 priority level로 갈지, 새 설정 때문에 client 동작이 바뀌지 않았는지, queue에서 대기 중이던 작업이 어떤 결과가 되는지를 정리한다. GitOps를 사용한다면 정책 manifest의 version, 적용 시간, 담당자, 변경 사유를 남겨야 한다. 제어면 정책은 application 코드보다 좁은 범위에서 바뀌어도 영향 범위가 넓을 수 있다.

## 한계와 적용 기준 Q&A

### Q. APF를 설정하면 API 서버 장애를 막을 수 있나요?

A. 아니다. APF는 요청 폭주에서 중요한 경로를 상대적으로 보호하는 장치이지, etcd 장애, 인증서 만료, admission webhook timeout, 네트워크 단절, control plane 용량 부족을 해결하지 않는다. API 서버가 전혀 응답하지 않는 상황에서는 우선순위를 나눌 기회도 없다. backup, control plane 고가용성, webhook timeout 정책, client retry 설계와 함께 봐야 한다.

### Q. 모든 배포 자동화를 높은 우선순위로 두면 안전하지 않나요?

A. 오히려 위험하다. 배포 자동화가 버그나 재시도 폭주를 일으켰을 때 높은 level의 예산을 소모해 회복에 필요한 요청을 압박할 수 있다. 긴급 rollback 경로와 일반 동기화 경로를 같은 service account로 묶어 두지 말고, 위험도와 호출량에 맞는 계정·동시성·backoff를 설계하는 편이 낫다.

### Q. `exempt`를 쓰면 queue 때문에 실패하지 않으니 가장 좋은 선택 아닌가요?

A. 아니다. exempt를 넓게 열면 APF의 보호막을 우회하는 트래픽이 늘어난다. 시스템 필수 요청이 아닌 사용자·CI·대시보드 계정에는 제한된 level을 사용하고, 요청량 자체를 줄이는 것이 기본이다. exempt가 필요하다고 판단했다면 왜 limited로는 불가능한지와 어떤 주체만 포함되는지를 별도로 검토해야 한다.

### Q. 어떤 규모에서 우선 검토해야 하나요?

A. 노드 수만으로 판단하지 않는다. 여러 팀·자동화가 API 서버를 공유하고, GitOps·security scan·inventory·autoscaler·operator가 많거나, incident 때 대량 목록 조회가 반복되는 환경이라면 작은 cluster도 경쟁이 커질 수 있다. 반대로 단일 팀의 단순 cluster라면 기본 정책과 client rate limit만으로 충분할 수 있다. 관찰된 요청 경쟁과 복구 중요도를 근거로 선택한다.

## 실무 점검 목록

- API 서버를 호출하는 서비스 계정과 사람 계정을 목적별로 구분했는가?
- list·watch·patch·create 중 어떤 verb가 많은지, 재시도 간격이 어떤지 확인했는가?
- 기본 FlowSchema와 PriorityLevelConfiguration을 읽고 새 규칙의 match 범위를 검토했는가?
- system component와 kubelet 관련 요청을 넓은 규칙에 포함시키지 않았는가?
- 낮은 우선순위 작업이 거절될 때 exponential backoff와 최대 재시도를 적용하는가?
- 큐 길이와 동시성 비율을 복사한 값이 아니라 서비스 목표와 caller 특성으로 정했는가?
- API 서버·etcd·webhook·GitOps controller를 함께 관찰할 수 있는가?
- 새 정책은 test cluster 또는 좁은 서비스 계정부터 적용하고 rollback 경로를 문서화했는가?

## 마무리

Kubernetes API Priority and Fairness는 API 서버를 더 빨리 만드는 마법이 아니라, 혼잡한 순간에도 어떤 요청이 제어면의 회복과 안전에 필요한지 선언하는 도구다. FlowSchema로 요청의 출처와 범위를 좁게 분류하고, PriorityLevelConfiguration으로 제한된 처리 예산과 대기 방식을 정한다. 좋은 정책은 많은 level을 만드는 정책이 아니라, 비효율적인 caller를 먼저 고치고 꼭 필요한 흐름만 분리해 system 요청과 복구 경로를 지키는 정책이다.

처음에는 background exporter나 reporting Job처럼 실패 영향이 작은 흐름 하나에서 시작하자. 실제 요청 주체와 재시도 동작을 확인하고, 큐가 찼을 때 무엇이 늦어져도 되는지 합의한 뒤 점진적으로 확대해야 한다. 제어면의 공정성은 YAML 숫자 한 줄이 아니라 credential 설계, 호출량 제한, 관찰, rollback 절차가 함께 만드는 운영 약속이다.

<h3 class="references-heading">참고 자료</h3>

- [Kubernetes: API Priority and Fairness](https://kubernetes.io/docs/concepts/cluster-administration/flow-control/)
- [Kubernetes API reference: FlowSchema](https://kubernetes.io/docs/reference/kubernetes-api/policy-resources/flow-schema-v1/)
- [Kubernetes API reference: PriorityLevelConfiguration](https://kubernetes.io/docs/reference/kubernetes-api/policy-resources/priority-level-configuration-v1/)
- [Kubernetes: Controlling Access to the Kubernetes API](https://kubernetes.io/docs/concepts/security/controlling-access/)
- [Kubernetes: API Priority and Fairness configuration](https://kubernetes.io/docs/concepts/cluster-administration/flow-control/#configuring)
