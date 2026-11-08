---
layout: post
title: "Kubernetes 워크로드 격리를 설계하는 법: Taint·Toleration·Node Affinity로 배치 경계 만들기"
categories: [Infrastructure]
tags: [kubernetes, taint, toleration, node-affinity, scheduling, infrastructure]
description: "Kubernetes의 taint·toleration·node affinity를 기반 개념부터 설명하고, 전용 노드·특수 하드웨어·운영 워크로드의 안전한 배치 경계를 설계하는 방법을 정리합니다."
---

## 먼저 답하기

### Q. nodeSelector만으로 전용 노드를 만들 수 있나요?

A. 특정 노드를 고르는 데는 도움이 되지만, 다른 Pod가 그 노드에 오지 못하게 막지는 못합니다. `nodeSelector`와 node affinity는 Pod가 어디에 *갈 수 있는지*를 표현합니다. 반대로 taint는 Pod가 명시적으로 허용하지 않으면 해당 node를 피하게 하는 반발 규칙입니다. 특정 팀·GPU 작업·운영 구성 요소를 위한 node를 지키려면 보통 label로 선택하고, taint로 무관한 Pod를 막으며, 필요한 Pod에만 toleration을 주는 조합을 검토합니다.

### Q. taint를 걸면 Pod가 이미 실행 중인 node에서도 즉시 사라지나요?

A. effect에 따라 다릅니다. `NoSchedule`은 새 Pod가 그 node에 배치되지 않게 하지만, 이미 실행 중인 Pod를 바로 내보내지는 않습니다. `NoExecute`는 새 배치를 막을 뿐 아니라 toleration이 없는 기존 Pod의 eviction(축출)에도 영향을 줍니다. 운영 중 node에 taint를 추가할 때는 application의 replica, PodDisruptionBudget, 종료 유예 시간, 대체 node 용량을 먼저 확인해야 합니다.

## 먼저 알아둘 기반 기술

### Kubernetes scheduler와 node label

Kubernetes에서 Pod는 컨테이너를 실행하는 최소 배포 단위이고, node는 Pod가 실제로 실행되는 worker machine입니다. scheduler는 Pod의 resource request, node 상태, label, affinity, taint, topology 같은 조건을 보고 후보 node를 찾고 점수를 매겨 배치합니다. scheduler가 항상 가장 빠른 node나 가장 비어 있는 node 하나를 고르는 것이 아니라, Pod가 선언한 제약과 cluster 정책 안에서 가능한 위치를 고른다는 점이 중요합니다.

node label은 node의 성격을 나타내는 key-value 표식입니다. 예를 들어 `workload.example.com/pool=payments`, `hardware.example.com/gpu=true`, `topology.kubernetes.io/zone=ap-northeast-2a`처럼 만들 수 있습니다. Pod의 `nodeSelector` 또는 node affinity는 이런 label을 조건으로 사용합니다. label은 선택 기준일 뿐 보안 경계나 접근 권한 자체가 아니므로, 누가 node label을 바꿀 수 있는지와 예약된 key를 어떻게 관리할지도 운영 정책에 포함해야 합니다.

### Taint와 toleration의 관계

taint는 node에 붙이는 "이 조건을 허용하지 않는 Pod는 피하라"는 표시입니다. 보통 `key=value:effect` 형태이며 effect는 `NoSchedule`, `PreferNoSchedule`, `NoExecute` 중 하나입니다. toleration은 Pod spec에 넣는 예외 규칙으로, 특정 key·value·effect의 taint를 이 Pod가 받아들일 수 있다고 scheduler와 node controller에 알립니다. toleration은 node 선택 명령이 아니라, taint 때문에 제외되지 않을 수 있다는 허용권입니다.

이 비대칭을 기억하면 설계가 쉬워집니다. node label만 쓰면 payment workload가 payment pool을 선호하거나 요구할 수 있지만, 일반 web Pod도 조건이 없다면 그 node에 배치될 수 있습니다. node에 `dedicated=payments:NoSchedule` taint를 붙이고 payment Pod에만 대응 toleration을 넣으면, 일반 Pod가 그 node를 쓰는 일을 줄일 수 있습니다. 여기에 required node affinity를 넣어 payment Pod가 실제 payment label node를 요구하게 하면 "아무 taint든 견디는 Pod"가 잘못된 전용 pool에 가는 위험도 낮아집니다.

### Hard constraint와 soft preference

`requiredDuringSchedulingIgnoredDuringExecution` node affinity는 조건에 맞는 node가 없으면 Pod를 pending으로 남기는 hard constraint입니다. `preferredDuringSchedulingIgnoredDuringExecution`은 맞는 node를 선호하지만 필요하면 다른 node에도 배치될 수 있는 soft preference입니다. 이름의 `IgnoredDuringExecution`은 배치 뒤 node label이 바뀌어도 일반적으로 이미 실행 중인 Pod를 자동으로 쫓아내지 않는다는 뜻입니다. label 변경을 장애 복구 수단으로 오해하면 안 됩니다.

hard constraint는 규제 데이터가 있는 node pool, 특정 CPU 아키텍처, device plugin이 설치된 GPU node처럼 다른 위치에서 실행하면 기능이 깨지는 경우에 적합할 수 있습니다. 하지만 node 수가 부족하거나 autoscaler가 조건을 만족하는 node를 만들지 못하면 Pod가 계속 pending이 됩니다. soft preference는 비용 최적화나 특정 zone 선호처럼 어겨도 서비스가 동작하는 조건에 더 잘 맞습니다. 중요한 것은 "원하는 위치"와 "반드시 필요한 위치"를 구분하는 일입니다.

## 왜 워크로드 격리가 필요한가

cluster를 공유하면 한 팀의 batch job, 잘못된 resource request, 대량 로그 처리, privileged Pod가 다른 팀의 API에 영향을 줄 수 있습니다. resource request와 limit은 CPU·memory 경쟁을 줄이는 기본 장치지만, GPU·고성능 disk·특수 네트워크처럼 비싼 node를 아무 Pod나 쓰지 못하게 하거나, 시스템 component를 일반 workload와 분리하려면 배치 경계가 더 필요할 수 있습니다. taint와 affinity는 이런 배치 의도를 Kubernetes 선언으로 표현하게 해 줍니다.

격리의 목표를 먼저 명확히 해야 합니다. 비용 절감인지, 성능 예측 가능성인지, 특수 hardware 보호인지, 규제상 분리인지, 장애 전파 감소인지에 따라 필요한 통제가 다릅니다. taint 하나로 namespace 권한, network 통신, secret 접근, container privilege를 해결할 수는 없습니다. workload placement는 여러 방어 층 중 하나이며, RBAC(Role-Based Access Control), NetworkPolicy, Pod Security 설정, resource quota, audit와 함께 봐야 합니다.

예를 들어 inference GPU pool에 일반 batch Pod가 올라가 비용과 queue가 늘어나는 문제가 있다면, GPU node label과 `NoSchedule` taint를 조합해 GPU workload에만 toleration을 줄 수 있습니다. 그러나 GPU workload라면 어떤 namespace에서든 toleration을 넣을 수 있는 상태라면 여전히 통제가 약합니다. admission policy와 RBAC로 누가 해당 Pod spec을 만들 수 있는지 제한하고, quota로 request 수를 제어해야 실제 경계가 됩니다.

## 효과별 동작을 구분하기

### NoSchedule: 새 배치를 막는 기본 경계

`NoSchedule` taint는 대응 toleration이 없는 새 Pod가 해당 node에 배치되지 않게 합니다. 전용 node pool을 만들 때 가장 먼저 검토할 effect입니다. 이미 node에 있는 Pod를 갑자기 내보내지 않아, 기존 workload에 주는 충격이 비교적 작습니다. 다만 scheduler가 예외를 처리하는 방식과 DaemonSet·system Pod의 toleration을 함께 봐야 합니다. cluster 기본 component가 필요한 node에서 예상치 못하게 배치되지 않으면 node 기능이 불완전해질 수 있습니다.

```bash
kubectl label nodes worker-gpu-01 workload.example.com/pool=gpu
kubectl taint nodes worker-gpu-01 dedicated=gpu:NoSchedule
```

명령 자체는 간단하지만, 단일 node에만 적용해선 운영 설계가 끝나지 않습니다. node group 전체에 동일한 label·taint가 적용되는지, 교체 node와 autoscaler가 같은 설정을 받는지, 사람이 수동으로 만든 node가 예외가 되지 않는지 확인합니다. infrastructure-as-code나 node group template으로 의도를 관리하면 node가 교체될 때 경계가 사라지는 일을 줄일 수 있습니다.

### PreferNoSchedule: 보장 없는 회피

`PreferNoSchedule`은 scheduler가 taint를 피하려 하지만, 다른 선택지가 없으면 배치할 수 있는 soft rule입니다. 개발·실험 pool처럼 가능한 한 일반 workload를 피하고 싶지만, availability를 더 우선하는 상황에 사용할 수 있습니다. 그러나 이 effect를 강한 격리로 해석하면 안 됩니다. cluster가 바쁠 때 일반 Pod가 들어올 수 있으므로, 비용이 큰 node나 보안 경계에는 `NoSchedule` 또는 더 강한 통제가 필요할 수 있습니다.

soft rule을 쓸 때는 왜 예외를 허용하는지 문서화합니다. 예를 들어 야간에만 쓰는 고사양 node를 낮 시간에 fallback으로 쓰게 할 수 있지만, 그 결과로 어떤 Pod가 쫓겨나거나 비용이 늘 수 있는지 관찰해야 합니다. scheduler 결정은 정적이지 않으므로, pending Pod 수·node utilization·eviction·autoscaler 동작을 대시보드에서 보고 의도가 실제로 지켜지는지 확인합니다.

### NoExecute: 실행 중인 Pod까지 영향을 주는 규칙

`NoExecute`는 가장 주의해야 할 effect입니다. toleration이 없는 새 Pod의 배치를 막고, 이미 실행 중인 Pod도 eviction 대상이 될 수 있습니다. node가 unreachable 또는 not-ready 상태일 때 Kubernetes가 사용하는 taint와 toleration도 이 개념과 연결됩니다. Pod에 `tolerationSeconds`를 설정하면 일정 시간만 해당 taint를 견디고 그 뒤 eviction되게 할 수 있습니다.

NoExecute를 node 유지보수나 장애 대응과 연결할 때는 application이 정상 종료할 시간, replica가 다른 node에 뜰 용량, PodDisruptionBudget이 허용하는 중단 수를 같이 계산합니다. taint를 붙였는데 replacement Pod가 affinity나 resource 조건 때문에 scheduling되지 않으면, 의도한 drain 대신 서비스 replica가 줄어들 수 있습니다. 운영 명령 하나가 배포와 용량 계획을 동시에 건드린다는 사실을 잊지 마세요.

## 전용 node pool의 선언 예시

다음은 payment workload가 payment pool에서만 실행되고, 그 pool을 일반 workload가 쓰지 않게 하려는 의도를 단순화한 예시입니다. 실제 label key와 namespace 정책은 조직 규칙에 맞춰 정해야 합니다.

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: payment-api
spec:
  replicas: 3
  template:
    spec:
      tolerations:
        - key: dedicated
          operator: Equal
          value: payments
          effect: NoSchedule
      affinity:
        nodeAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            nodeSelectorTerms:
              - matchExpressions:
                  - key: workload.example.com/pool
                    operator: In
                    values: [payments]
      containers:
        - name: api
          image: registry.example.com/payment-api:1.0.0
```

이 YAML은 payment Pod가 toleration을 갖고 payment label node를 요구한다는 뜻입니다. 그러나 실제 production 배포에는 CPU·memory request, topology spread, anti-affinity, readiness probe, ServiceAccount, NetworkPolicy, PodDisruptionBudget도 필요할 수 있습니다. 이 예시가 모든 보안과 고가용성을 해결하는 template는 아닙니다. 필요한 것만 명시하고, 각 제약이 Pod의 pending 가능성과 장애 복구에 주는 영향을 검증해야 합니다.

## 업무 예시: GPU 추론과 일반 API를 함께 운영할 때

한 cluster에서 일반 주문 API와 LLM inference workload를 함께 운영한다고 가정합니다. GPU node는 비용이 높고 device plugin·driver·특정 runtime이 필요할 수 있습니다. 일반 API가 resource request를 잘못 설정해 GPU node에 올라가면, 실제 추론 request가 대기하거나 autoscaler가 불필요한 GPU node를 늘릴 수 있습니다. 반대로 inference Pod가 일반 node에 배치되면 필요한 device를 찾지 못하고 시작에 실패할 수 있습니다.

먼저 GPU node group에 일관된 label과 `dedicated=gpu:NoSchedule` taint를 둡니다. inference Deployment에는 해당 toleration과 GPU label의 required affinity를 넣습니다. 일반 API에는 toleration을 넣지 않습니다. 그 다음 RBAC와 admission policy로 임의 namespace가 GPU toleration과 resource request를 추가할 수 있는지 검토하고, namespace quota·limit range로 team별 사용량을 관리합니다. 필요하면 GPU node와 일반 node의 network 접근도 NetworkPolicy로 분리합니다.

배포 전에는 node가 하나만 남았을 때 Pod가 어떻게 되는지, autoscaler가 label·taint가 맞는 node를 만들 수 있는지, inference Pod update 중 용량이 충분한지, DaemonSet이 GPU node에서 정상 실행되는지 확인합니다. 배포 뒤에는 pending Pod의 scheduling event, GPU request·utilization, 일반 API의 node 분포, 비용 지표를 관찰합니다. 격리는 YAML을 적용한 순간 끝나는 일이 아니라, 실제 scheduler와 autoscaler가 의도를 계속 지키는지 확인하는 운영 과정입니다.

## 흔한 실수와 점검 순서

첫째, toleration을 권한처럼 주는 실수입니다. toleration이 있다고 특정 node만 선택하는 것은 아닙니다. affinity나 nodeSelector가 없으면 조건을 만족하는 다른 node에도 갈 수 있습니다. 반대로 taint만 있고 Pod toleration이 없으면 전용 workload도 배치되지 않습니다. label로 선택, taint로 보호, toleration으로 예외 허용이라는 역할을 분리해 읽어야 합니다.

둘째, 모든 workload에 broad toleration을 넣는 실수입니다. `operator: Exists`로 넓은 toleration을 주면 의도하지 않은 taint를 모두 견딜 수 있어, 전용 pool 정책이 무력화될 수 있습니다. 가능한 한 key·value·effect를 좁게 적고, 왜 필요한지 Pod template과 배포 정책에서 추적할 수 있게 합니다. broad toleration이 필요한 system component라면 영향 범위와 보안 검토를 더 엄격히 합니다.

셋째, pending 상태를 단순 장애로 보는 실수입니다. Pod가 pending이면 `kubectl describe pod`의 event에서 taint 불일치, affinity 불일치, resource 부족, node selector 오류 중 무엇인지 확인합니다. scheduler가 Pod를 배치하지 않는 것은 종종 정책이 의도대로 작동한다는 신호입니다. 원인을 보지 않고 toleration을 추가하면 정책을 우회해 문제를 숨길 수 있습니다.

넷째, node를 drain할 때 taint·PDB·capacity 관계를 무시하는 실수입니다. maintenance 중인 node의 workload를 다른 곳으로 옮기려면, 대체 node가 required affinity와 resource request를 만족해야 하고 PDB가 허용하는 범위에서 Pod가 종료돼야 합니다. storage가 붙은 stateful workload는 volume attachment와 zone 조건도 추가로 고려해야 합니다. 사전에 작은 pool에서 절차를 연습하고, 실제 유지보수 창에는 rollback 조건을 두는 편이 안전합니다.

## scheduler가 실제로 보는 조건 읽기

Pod가 배치되는 과정은 label 하나를 비교하는 단순한 필터가 아닙니다. scheduler는 Pod의 resource request가 node allocatable에 들어가는지, nodeSelector와 node affinity가 맞는지, taint를 toleration하는지, host port 충돌이 없는지, volume의 zone 제약을 만족하는지 같은 조건을 먼저 봅니다. 그 뒤 여러 후보 중 topology spread, preferred affinity, 현재 resource 분포 같은 점수 요소를 고려할 수 있습니다. 따라서 "label이 맞는데도 pending"이라는 현상은 taint 외의 조건이 막고 있을 수 있습니다.

조사는 Pod 이벤트에서 시작합니다. `kubectl describe pod`는 어떤 node가 왜 제외됐는지 보여 주는 경우가 많습니다. `had untolerated taint`, `didn't match Pod's node affinity`, `Insufficient cpu` 같은 문구를 조건별로 나누어 읽습니다. 실제 node의 label과 taint는 다음처럼 확인할 수 있습니다.

```bash
kubectl get nodes --show-labels
kubectl describe node worker-gpu-01
kubectl describe pod inference-api-7c9f8d6b45-x2pqw
```

명령 결과에 민감한 label·내부 주소·tenant 이름이 포함될 수 있으므로 incident ticket이나 외부 채널에 그대로 붙이지 않습니다. 필요한 조건과 event만 추려 공유하고, node 상태를 임의로 바꾸기 전에 이 Pod가 필요한 hard constraint를 갖는지 확인합니다. pending을 없애려고 affinity를 삭제하거나 `Exists` toleration을 추가하면, scheduler 문제는 사라져도 배치 정책이 사라질 수 있습니다.

## autoscaler와 node template의 관계

cluster autoscaler 또는 cloud provider의 node autoscaling을 쓰면 Pod가 pending일 때 새 node가 만들어질 수 있습니다. 하지만 autoscaler가 Pod의 node affinity, selector, taint·toleration, node group의 label template을 이해할 수 있어야 합니다. GPU Pod가 `accelerator=nvidia` label을 요구하는데 node group template에 그 label이 없거나 새 node에 `dedicated=gpu:NoSchedule` taint가 빠지면, scale-out 뒤에도 scheduling이 실패하거나 일반 workload가 GPU node를 차지할 수 있습니다.

새 node가 생길 때 어떤 label·taint·DaemonSet이 자동으로 붙는지 node group 설정과 bootstrap script에서 확인합니다. 사람이 수동으로 기존 node에만 label을 붙인 구조는 scale-out·node 교체 때 쉽게 무너집니다. 또한 max node 수, zone별 용량, cloud quota, device plugin 시작 시간, image pull 시간을 고려해야 합니다. Pod가 pending이라는 사실만으로 autoscaler가 즉시 해법을 제공한다고 가정하면 안 됩니다.

autoscaling 실험은 production에서 우연히 확인하지 말고, 작은 workload로 node 부족·scale-out·Pod 배치·scale-in 순서를 관찰합니다. scale-in 중 전용 node의 Pod가 어디로 이동하는지, PDB 때문에 node 삭제가 지연되는지, local storage가 있는 workload가 어떻게 되는지 확인합니다. 특히 hard affinity로 좁은 pool만 허용한 서비스는 그 pool의 최소 node 수와 quota가 availability의 일부가 됩니다.

## DaemonSet과 system workload의 예외

DaemonSet은 각 node 또는 조건에 맞는 node마다 Pod를 하나씩 배치하는 controller입니다. CNI, log agent, monitoring agent, GPU device plugin처럼 node 자체에 필요한 component가 대표적입니다. 전용 node에 taint를 붙였는데 필요한 DaemonSet이 toleration을 갖지 않으면, node는 생성됐지만 네트워크·로그·device 기능이 준비되지 않는 문제가 생길 수 있습니다.

반대로 모든 DaemonSet에 모든 taint를 허용하는 broad toleration을 주는 것도 위험합니다. privileged agent가 불필요한 node pool까지 확장되거나, 작은 실험 cluster의 자원을 계속 소비할 수 있습니다. component별로 어느 node pool에서 필수인지, 어떤 taint를 허용해야 하는지, host path·host network·권한이 필요한지 검토합니다. system workload의 toleration은 운영 편의가 아니라 cluster 신뢰 경계의 일부입니다.

node를 새로 만들거나 taint 정책을 바꾼 뒤에는 일반 Deployment만 보지 말고 DaemonSet desired/current/ready 수를 확인합니다. GPU node에서 device plugin Pod가 ready인지, log collector가 실행되는지, node readiness가 정상인지 살펴야 합니다. application Pod가 이미지 pull 오류로 보이는 문제가 실제로는 node agent 미배치일 수 있기 때문입니다.

## zone 분산과 전용 pool을 함께 설계하기

전용 node pool을 만들면 후보 node 수가 줄어들기 때문에 장애 도메인 분산이 더 중요해집니다. 모든 payment Pod가 같은 zone의 세 node에만 있고 해당 zone에 문제가 생기면, 다른 zone에 여유가 있어도 hard affinity 때문에 replica가 뜨지 않을 수 있습니다. node label에 zone이 정확히 있는지, 전용 pool이 여러 zone에 존재하는지, topology spread constraint와 Pod anti-affinity가 replica를 어떻게 분산하는지 확인합니다.

분산 규칙도 절대값으로 복사하지 않습니다. replica가 두 개인 서비스에 세 zone 분산을 강제하면 한 zone에 node가 없을 때 계속 pending이 될 수 있습니다. 반대로 한 zone에만 몰리는 것을 허용하면 비용은 줄어도 장애 영향이 커집니다. 서비스의 RTO(Recovery Time Objective, 복구 목표 시간), RPO(Recovery Point Objective, 복구 시점 목표), 요청 특성, node pool 비용을 기준으로 minimum replica와 분산 조건을 함께 정합니다.

storage가 붙는 stateful application은 zone 제약이 더 강합니다. PersistentVolume의 topology, volume binding 시점, database replication 방식이 Pod scheduling과 연결됩니다. stateful workload를 전용 node에 배치한다고 해서 무조건 안전해지는 것은 아닙니다. data replica가 어느 zone에 있고 failover 때 Pod가 갈 수 있는 node가 있는지, maintenance 중 volume attach가 지연되면 어떻게 대응하는지 별도 runbook이 필요합니다.

## 정책을 코드로 검증하기

배치 정책은 YAML 리뷰만으로 유지하기 어렵습니다. 새 chart나 팀이 `tolerations`에 넓은 `Exists` 규칙을 넣거나, GPU workload가 required affinity 없이 배포될 수 있습니다. admission controller나 policy-as-code 도구를 이용해 특정 namespace의 Pod에 필요한 node affinity가 있는지, 전용 taint toleration은 승인된 ServiceAccount나 namespace만 쓸 수 있는지, resource request가 필요한지 검사할 수 있습니다. 정책 도입 전에는 기존 workload의 예외를 inventory로 만들고, 경고 모드에서 영향 범위를 확인하는 편이 안전합니다.

정책의 목표는 모든 Pod spec을 획일화하는 것이 아닙니다. 예를 들어 일반 web workload에는 GPU toleration을 금지하고, GPU namespace에는 accelerator request와 node affinity를 요구하며, system namespace의 DaemonSet에는 승인된 toleration 목록만 허용하는 식으로 위험에 맞춰 범위를 좁힙니다. 거부 규칙을 바로 강제하기보다 sample deployment와 CI manifest 검증으로 오류 메시지가 이해 가능한지 확인하면 개발자가 우회 설정을 만드는 일을 줄일 수 있습니다.

policy가 거부한 배포, scheduling 실패, 예상 밖의 node pool 사용량은 운영 지표입니다. 경고가 너무 많다면 정책이 현실과 맞지 않거나 team의 배포 template가 부족한 신호일 수 있습니다. 예외를 모두 허용하는 대신, 왜 필요한지·언제 재검토할지·어떤 위험을 수용하는지 기록하면 policy가 실무와 분리되는 것을 막을 수 있습니다.

## 유지보수와 장애 대응 runbook

전용 node를 유지보수하기 전에는 먼저 pool의 healthy node 수와 각 Pod의 required affinity를 확인합니다. 다음으로 PDB가 허용하는 중단 수, replica의 readiness, 대체 node의 CPU·memory·device 여유, stateful volume의 zone을 확인합니다. 이 조건이 맞지 않으면 drain 명령은 실행하지 않습니다. 변경 창에 여유가 없을 때 taint를 무작정 `NoExecute`로 바꾸면, 계획하지 않은 eviction과 서비스 저하가 생길 수 있습니다.

실제 runbook에는 시작 조건, 중단 조건, 관찰 지표, rollback 단계를 둡니다. 예를 들어 node cordon 뒤 replacement Pod가 정해진 시간 안에 다른 node에서 ready가 되는지 확인하고, pending event가 affinity·taint·capacity 중 무엇을 가리키는지 기록합니다. 서비스 오류율이나 queue가 정한 임계값을 넘으면 다음 node drain을 멈추고, 필요하면 cordon을 해제하거나 용량을 먼저 확장합니다. 명령을 아는 것과 안전하게 유지보수하는 것은 다른 능력입니다.

사후에는 어떤 Pod가 예상과 다르게 이동했는지, autoscaler가 어떤 node를 만들었는지, PDB와 종료 유예가 실제로 충분했는지 검토합니다. 이 기록은 다음 maintenance와 cluster upgrade에서 같은 위험을 줄이는 근거가 됩니다. taint·toleration은 한 줄 YAML이지만, 그 줄이 적용되는 시간에는 scheduler·autoscaler·storage·application 종료가 함께 움직입니다.

## resource request와 격리의 비용

전용 node pool은 경쟁을 줄이지만 여유 자원을 묶어 둘 수 있습니다. payment pool에 CPU 8개가 남아 있고 일반 pool이 부족해도, hard affinity와 taint 때문에 일반 workload가 그 여유를 쓸 수 없을 수 있습니다. 이 비용은 잘못된 설계의 증거가 아니라, 예측 가능성·보안·hardware 보호를 위해 조직이 선택한 trade-off일 수 있습니다. 다만 선택한 이유와 최소 node 수, 평소 utilization, peak 시 용량을 측정하지 않으면 과도한 격리가 비용 낭비로 바뀔 수 있습니다.

request를 실제 사용량보다 과도하게 잡으면 scheduler는 빈 공간이 있어도 Pod를 배치하지 못하고 autoscaler가 불필요하게 node를 늘릴 수 있습니다. 반대로 너무 작게 잡으면 같은 node에 많은 Pod가 몰려 CPU throttling·memory eviction이 발생할 수 있습니다. 전용 pool 정책을 도입할 때는 taint만 보지 말고, 해당 workload의 request·limit·HPA·queue·성장률을 함께 검토합니다. placement 정책은 capacity planning에서 분리된 YAML 조각이 아닙니다.

비용을 줄이려고 `PreferNoSchedule`로 모든 경계를 약하게 만들면, peak 때 중요한 pool이 일반 workload로 채워질 수 있습니다. 더 나은 방법은 보호가 꼭 필요한 workload와 shared pool을 명확히 나누고, shared pool에는 우선순위·preemption·resource quota 같은 다른 도구를 검토하는 것입니다. 어떤 Pod가 다른 Pod를 밀어낼 수 있는지 역시 사용자 영향이 큰 정책이므로, priority class를 추가한다면 충분한 테스트와 승인 절차가 필요합니다.

## 배치 정책을 변경할 때의 migration

이미 운영 중인 cluster에 새 taint를 추가하면 기존 Pod와 새 Pod가 다른 규칙을 따르는 과도기가 생깁니다. 바로 `NoSchedule`을 붙이면 새 rollout은 pending인데 기존 일반 Pod는 전용 node에 남아 있을 수 있습니다. 이 상태를 오류로 보지 말고 migration 계획으로 관리합니다. 먼저 node inventory와 현재 Pod 분포를 수집하고, 전용 workload에 toleration과 affinity를 배포하며, 일반 workload가 다른 node에서 충분히 실행될 용량을 확보한 뒤 taint를 적용합니다.

다음 단계에서는 기존 일반 Pod를 점진적으로 재시작하거나 node drain 절차로 이동시킬 수 있습니다. 이때 서비스별 PDB와 replica 수를 확인하고, 한 번에 모든 node를 비우지 않습니다. migration 중 scheduler event, pending 수, error rate, node utilization을 보며 중단 조건을 적용합니다. 예상과 다르게 특정 deployment가 전용 node에 의존하고 있었다면, toleration을 넓혀 임시로 해결하기 전에 해당 의존이 의도된 것인지 조사해야 합니다.

정책 변경은 manifest repository와 node provisioning 설정에 함께 반영해야 합니다. Pod template만 고치고 node group template을 잊으면 다음 scale-out에서 label·taint가 사라질 수 있고, node만 바꾸고 chart default를 고치지 않으면 다음 deployment가 old policy를 되살릴 수 있습니다. 변경 전후를 검증하는 작은 automated check가 있으면 좋습니다. 예를 들어 샘플 Pod가 허용된 pool에만 schedule되는지, 일반 Pod가 GPU taint node에 pending되는지, 필요한 DaemonSet이 모든 pool에서 ready인지 확인할 수 있습니다.

## 관찰 지표를 운영 질문으로 바꾸기

dashboard에 node CPU 그래프만 있어서는 taint 정책의 효과를 알기 어렵습니다. 전용 pool별 allocatable 대비 requested resource, 실제 utilization, pending Pod와 scheduling failure reason, node별 Pod 종류, autoscaler scale-out 시간, eviction 수, PDB 차단 횟수를 함께 봅니다. 이 지표들은 "전용 node가 비싼가"보다 "필요한 workload가 필요한 시간에 배치되는가"를 답하게 해 줍니다.

alert도 행동과 연결합니다. GPU inference Pod가 5분 이상 pending이면 on-call이 label·taint·capacity·device plugin 중 무엇을 확인할지 runbook에 적습니다. 일반 workload가 GPU node에서 실행되는 비율이 증가하면 policy 누락인지 긴급 fallback인지 구분합니다. node pool이 계속 비어 있으면 최소 node 수나 reservation을 재검토합니다. 알림이 많다고 toleration을 넓히는 대신, 어떤 constraint가 실제 제품 위험을 줄이는지 기준으로 원인을 고쳐야 합니다.

배치 이벤트와 business signal을 함께 보면 더 좋습니다. payment Pod가 다른 pool로 이동한 직후 latency가 증가했는지, GPU queue가 길어질 때 autoscaler가 충분히 빨랐는지, maintenance 중 어떤 API의 error rate가 변했는지 연결합니다. 단지 scheduler가 성공했다는 사실은 사용자가 정상 서비스를 받았다는 증거가 아닙니다. 반대로 지표 변동이 있어도 정책 변경과 직접 관계가 있는지 baseline과 시간대를 비교해야 합니다.

## team interface를 명확히 하기

node pool 정책에는 platform team, application team, security team, finance 또는 data team의 관심사가 섞입니다. platform team은 node template·autoscaler·cluster upgrade를 관리하고, application team은 request·affinity·readiness·replica를 책임지며, security team은 toleration을 누가 추가할 수 있는지와 privileged workload를 검토할 수 있습니다. 책임자가 불명확하면 application team은 pending을 해결하려 broad toleration을 넣고, platform team은 node를 늘리며, 비용과 보안 위험은 나중에 발견됩니다.

작게 시작할 때도 interface는 문서화합니다. 새 전용 pool 요청에 필요한 정보는 무엇인지, label과 taint key의 naming rule은 무엇인지, 예외 toleration은 누가 승인하는지, autoscaling·quota·network 정책은 누가 변경하는지 정합니다. 이 과정은 관료주의를 늘리기 위한 것이 아니라, Pod 하나의 YAML 변경이 여러 운영 경계를 넘는다는 사실을 드러내는 방법입니다.

## 실제 적용 전 체크리스트

새 전용 pool을 만들기 전에는 목적이 비용·성능·보안·hardware 중 무엇인지 한 문장으로 적습니다. 다음으로 pool의 label, taint effect, 허용할 namespace 또는 ServiceAccount, Pod의 required/preferred affinity, resource request, 최소·최대 node 수를 확인합니다. DaemonSet, CNI, monitoring, device plugin이 해당 node에서 ready인지도 포함합니다. 마지막으로 node 하나가 사라질 때 replacement Pod가 어디에 뜨고, PDB·volume·zone이 그 이동을 허용하는지 테스트합니다.

이 체크리스트를 모두 만족해야만 taint를 쓸 수 있다는 뜻은 아닙니다. 위험이 낮은 개발 cluster는 간단한 label과 `NoSchedule`부터 시작할 수 있습니다. 다만 production의 결제·개인정보·고가 hardware workload는 간단한 설정처럼 보이는 배치 규칙이 capacity와 security에 미치는 영향을 더 깊이 검토해야 합니다. 명시적인 제한과 관찰 계획이 있어야 격리가 실제 신뢰성으로 이어집니다.

## 장애 시 정책을 우회하지 않는 방법

서비스가 급하게 pending 상태가 되면 가장 쉬운 대응은 broad toleration을 넣거나 affinity를 지우는 일처럼 보입니다. 하지만 이 변경은 Pod를 띄우는 대신 전용 hardware를 침범하거나, 보안·성능을 위해 만든 경계를 해제할 수 있습니다. 먼저 scheduler event와 node capacity, autoscaler, label·taint template, DaemonSet 상태를 확인하고 원인을 분류합니다. 용량 부족이면 노드를 늘리고, label 누락이면 provisioning을 고치고, request 과다면 workload 설정을 조정하는 식으로 원인에 맞는 변경을 선택합니다.

긴급 완화가 꼭 필요하다면 범위를 좁힙니다. 특정 Deployment의 replica 하나에만 임시 toleration을 허용할지, 짧은 기간의 feature flag로 workload를 줄일지, 승인된 shared pool로 일부 트래픽을 전환할지 결정하고 만료 시점과 되돌림 담당자를 기록합니다. 임시 변경이 다음 배포 template에 영구 반영되지 않게 하고, incident가 끝난 뒤에는 왜 기존 pool이 부족했는지와 어떤 관찰 신호를 놓쳤는지 회고합니다. scheduler 정책은 평상시뿐 아니라 압박 상황에서 지킬 수 있어야 의미가 있습니다.

## 테스트 환경에서도 확인할 수 있는 것

production 규모의 node pool이 없어도 개발 cluster에서 policy의 기본 동작을 검증할 수 있습니다. 일반 Pod에는 전용 taint의 toleration이 없을 때 pending event가 나오는지, 승인된 Pod에는 label·affinity·toleration을 함께 넣었을 때 정상 배치되는지, DaemonSet이 전용 node에서 ready가 되는지 확인합니다. manifest test나 admission policy test로 namespace별 허용 규칙을 검증하면, 사람이 console에서 label을 확인하기 전에 잘못된 YAML을 발견할 수 있습니다.

다만 작은 cluster의 성공을 production 용량 검증으로 해석하지 않습니다. zone 분산, autoscaler quota, 실제 image pull 시간, storage attach, 수백 Pod가 동시에 이동하는 상황은 별도 검증이 필요합니다. 테스트 환경은 배치 계약이 문법과 기본 정책을 지키는지 확인하는 장소이고, production-like 환경 또는 점진 rollout은 실제 운영 제약을 확인하는 장소입니다. 둘을 나누면 작은 테스트도 가치가 있고, 큰 변경의 위험도 숨기지 않게 됩니다.

## 배치 정책의 수명주기

전용 pool은 한 번 만든 뒤 고정된 구조가 아닙니다. 서비스가 줄어들거나 GPU 세대가 바뀌고, 새 zone이 추가되며, 팀 경계가 달라지면 기존 label과 taint가 더 이상 업무 의미를 표현하지 못할 수 있습니다. 분기별 또는 큰 cluster 변경 전에는 pool별 owner, 사용 workload, 최근 utilization, 예외 toleration, 미사용 node, pending 사고 이력을 검토합니다. 더 이상 필요한 이유가 없는 pool은 migration 계획을 세워 shared pool로 합치거나 제거하는 편이 좋습니다.

label key도 장기 API처럼 다룹니다. `team=alpha`처럼 자주 바뀌는 조직명을 node 정책에 넣으면 조직 개편 때 많은 Pod와 autoscaler 설정을 함께 바꿔야 합니다. `workload-class=regulated`나 `hardware-class=gpu`처럼 배치 이유를 표현하는 안정적인 key가 보통 더 낫습니다. key를 바꿔야 한다면 구 label과 신 label을 잠시 병행하고, 모든 template·node group·policy가 전환됐는지 확인한 뒤 이전 key를 제거합니다.

이런 정리는 YAML을 예쁘게 만드는 일이 아닙니다. 사용되지 않는 toleration과 오래된 node pool은 장애 때 선택지를 늘리고, 보안 검토와 비용 분석을 어렵게 합니다. 격리 정책에도 생성·확장·검토·폐기의 수명주기를 두면 cluster가 커져도 scheduler의 결정을 설명할 수 있습니다.

새 정책은 문서와 실제 cluster가 같은지 확인해야 합니다. node label·taint 목록과 허용 namespace, autoscaler template, 배포 chart의 affinity를 정기적으로 대조합니다. 한쪽만 바뀌면 scheduler는 의도와 다르게 동작합니다. 이 단순한 대조가 전용 pool을 오래 운영할 때 가장 값싼 예방책이 될 수 있습니다.

정기 점검에는 실제 pending event와 예외 toleration도 포함합니다. 선언과 현실의 차이를 빨리 발견할수록 장애 때 급한 우회 설정을 줄일 수 있습니다.

운영자는 변경 전후의 Pod 분포를 비교하고, 전용 node에 남아야 할 workload와 떠나야 할 workload를 목록으로 확인합니다. 이 확인은 scheduler가 정상이었다는 기술적 사실을 사용자 영향이 없는 운영 결과로 연결합니다. 정책의 목적, 허용 예외, 검증 증거를 함께 남기면 다음 담당자도 같은 경계를 안전하게 수정할 수 있습니다.

작은 배치 규칙도 release 전에 검토하고, 적용 뒤 결과를 확인하는 습관이 장기적인 cluster 안정성을 만듭니다.

## 한계와 적용 기준 Q&A

### Q. taint와 toleration만으로 다른 팀의 접근을 막을 수 있나요?

A. 아닙니다. 배치 위치를 제어할 뿐, Pod 작성 권한·secret 조회·network 통신·container privilege를 직접 제한하지 않습니다. RBAC, admission policy, NetworkPolicy, namespace quota, image 정책을 함께 사용해야 합니다.

### Q. 모든 node pool에 taint를 붙이는 것이 좋은가요?

A. 목적이 분명한 pool부터 시작하는 편이 낫습니다. 모든 node에 복잡한 taint를 붙이면 일반 workload가 pending이 됐을 때 원인을 찾기 어려워집니다. GPU, 규제 workload, system component처럼 보호할 이유가 큰 pool의 label·taint·toleration을 명확히 하고, 운영 경험을 바탕으로 넓히세요.

### Q. NoExecute를 사용하면 node drain 명령이 필요 없나요?

A. 아닙니다. NoExecute는 eviction에 영향을 줄 수 있지만, maintenance 절차에는 PodDisruptionBudget, graceful shutdown, DaemonSet 처리, local data, volume detach, 대체 용량 확인이 포함됩니다. 의도하지 않은 축출을 막기 위해 drain과 taint의 역할을 구분해 runbook을 만드세요.

### Q. Pod가 pending이면 affinity를 preferred로 바꾸면 되나요?

A. 해당 위치가 기능·보안·hardware 때문에 반드시 필요하다면 preferred로 완화하면 문제를 다른 node에서 실패하는 형태로 옮길 수 있습니다. 먼저 resource 부족인지 label·taint 오류인지 autoscaler 조건 문제인지 확인하고, 필요 조건과 선호 조건을 다시 구분하세요.

## 마무리

Kubernetes의 taint·toleration·node affinity는 단순한 scheduler 옵션이 아니라, 어떤 workload가 어떤 node에서 실행돼야 하고 어떤 Pod를 그곳에서 막아야 하는지 선언하는 도구입니다. label로 선택하고 taint로 보호하며 toleration으로 좁은 예외를 주되, resource·권한·network·autoscaling·유지보수 절차까지 함께 설계하세요. 그러면 전용 node pool은 비용과 장애를 숨기는 임시 해법이 아니라, 설명 가능하고 운영 가능한 배치 경계가 됩니다.

<h3 class="references-heading">참고 자료</h3>

- [Kubernetes Documentation: Taints and Tolerations](https://kubernetes.io/docs/concepts/scheduling-eviction/taint-and-toleration/)
- [Kubernetes Documentation: Assigning Pods to Nodes](https://kubernetes.io/docs/concepts/scheduling-eviction/assign-pod-node/)
- [Kubernetes Documentation: Node Affinity](https://kubernetes.io/docs/concepts/scheduling-eviction/assign-pod-node/#node-affinity)
- [Kubernetes Documentation: Dedicated Nodes](https://kubernetes.io/docs/concepts/scheduling-eviction/taint-and-toleration/#example-use-cases)
