---
layout: post
title: "Kubernetes Pod 배치를 설계하는 법: Topology Spread·Affinity·Taint로 장애 도메인 나누기"
category: Infrastructure
description: "Kubernetes에서 Pod를 노드·가용 영역·호스트에 어떻게 분산할지, topology spread constraints와 affinity, taint·toleration의 역할과 운영 기준을 설명합니다."
---

<section class="quick-answers"><h2>먼저 답하기</h2><p><strong>Q. replica 수만 여러 개면 노드 장애에도 자동으로 안전한가요?</strong><br>A. 아닙니다. 여러 Pod가 같은 노드나 같은 가용 영역에 몰리면 한 번의 장애로 함께 사라질 수 있습니다. replica 수와 배치 분산은 별도의 설계 항목입니다.</p><p><strong>Q. 모든 서비스에 강한 분산 규칙을 넣으면 더 안전한가요?</strong><br>A. 아닙니다. cluster 규모가 작거나 자원이 부족할 때 Pod가 Pending 상태가 될 수 있습니다. 가용성 목표와 배포 가능성을 함께 정해야 합니다.</p></section>

## 먼저 알아둘 기반 기술

Kubernetes에서 Pod는 container를 실행하는 가장 작은 배포 단위이고, node는 Pod가 실제로 실행되는 서버입니다. Deployment는 원하는 replica 수를 유지하고, scheduler는 새 Pod가 어느 node에서 실행될지 선택합니다. scheduler는 CPU와 memory request가 남아 있는지, node selector와 affinity 조건을 만족하는지, taint를 허용하는지 같은 정보를 종합합니다. replica를 세 개로 만들었다는 사실만으로 서로 다른 물리 서버에 놓인다는 보장은 없습니다.

장애 도메인(failure domain)은 같은 원인으로 함께 영향을 받을 수 있는 범위입니다. 한 대의 node, 한 rack, 한 availability zone, 같은 전원 장치나 network path가 장애 도메인이 될 수 있습니다. cloud 환경에서는 node label의 zone 값으로 가용 영역을 구분하고, on-premise 환경에서는 rack·host·datacenter label을 직접 설계할 수 있습니다. 어떤 label을 기준으로 나눌지는 실제 인프라 구조와 장애 시나리오에 맞춰야 합니다.

스케줄링은 빈 node를 찾는 기능만이 아닙니다. 요청이 많은 API replica를 한 node에 몰면 CPU 여유가 있어도 network·disk·kernel 자원과 장애 위험을 공유합니다. 반대로 너무 엄격하게 멀리 분산하면 남는 자원이 있어도 Pod가 배치되지 않거나 node 비용이 커질 수 있습니다. 배치 정책은 성능, 가용성, 비용, 배포 속도 사이의 선택입니다.

## replica와 분산은 다른 문제다

온라인 주문 API를 세 replica로 실행한다고 가정해 보겠습니다. scheduler가 우연히 세 Pod를 한 node에 배치하면 평상시에는 부하를 나누어 처리할 수 있습니다. 하지만 그 node가 재부팅되거나 network에서 분리되면 세 replica가 동시에 사라집니다. Deployment는 새 Pod를 다른 node에 만들려고 하지만 image pull, scheduler 대기, readiness 시간 동안 사용자는 오류를 볼 수 있습니다. 즉 replica는 처리량과 복구의 기반이고, 분산은 같은 실패가 동시에 replica를 잃지 않게 하는 장치입니다.

가용 영역이 여러 개인 cluster에서도 같은 원리가 적용됩니다. 모든 Pod가 한 zone에 있으면 zone 단위 장애에 취약합니다. 반대로 각 zone에 최소 한 Pod를 강제하면 zone 장애 때 남은 zone이 traffic을 받아야 합니다. 남은 zone의 node 용량과 database, load balancer, 외부 API가 그 traffic을 감당하는지도 별도로 확인해야 합니다. Pod를 흩어 놓는 것이 전체 시스템의 여유 용량을 만드는 것은 아닙니다.

배포 중에도 배치가 중요합니다. rolling update가 새 Pod를 기존 Pod와 같은 node에 만들고 이어서 node drain이 시작되면 의도보다 많은 replica가 비어 있을 수 있습니다. PodDisruptionBudget는 자발적 중단에서 가용 Pod 수를 지키는 도구지만, scheduler가 어디에 배치할지 직접 결정하지는 않습니다. 분산 규칙, readiness probe, update strategy, node maintenance 절차가 함께 맞아야 합니다.

## topology spread constraints의 역할

topology spread constraints는 label이 같은 Pod를 topology domain 사이에 비교적 고르게 나누도록 scheduler에 요청하는 기능입니다. `topologyKey`에는 `kubernetes.io/hostname`처럼 node별로 다른 label이나 `topology.kubernetes.io/zone`처럼 zone별로 같은 label을 사용합니다. `labelSelector`는 어떤 Pod 묶음의 분포를 비교할지 정하고, `maxSkew`는 가장 많은 domain과 가장 적은 domain 사이에 허용할 차이를 의미합니다.

예를 들어 세 zone에 API Pod 여섯 개를 배치할 때 zone 기준 `maxSkew: 1`을 두면 scheduler는 가능하면 두 개씩 분산하려 합니다. node 기준 규칙도 추가하면 같은 zone 안에서 특정 node에 몰리는 일을 줄일 수 있습니다. 다만 zone과 node 규칙을 동시에 쓸 때에는 각 규칙이 가능한 node 후보를 어떻게 좁히는지 이해해야 합니다. 설정이 많다고 자동으로 더 좋은 균형이 생기는 것은 아닙니다.

`whenUnsatisfiable`은 분산을 맞출 수 없을 때의 행동을 정합니다. `DoNotSchedule`은 규칙을 지킬 수 없으면 Pod를 Pending으로 둡니다. 장애 도메인 분리가 필수인 중요한 workload에는 의미가 있지만, zone 하나가 비었거나 작은 cluster에서는 배포 자체가 막힐 수 있습니다. `ScheduleAnyway`는 배치를 허용하되 균형을 더 좋게 만드는 node를 선호합니다. 서비스가 즉시 실행되는 것과 완벽한 분산 중 어느 쪽을 우선할지 업무 기준이 필요합니다.

## affinity와 anti-affinity를 구분하기

node affinity는 Pod가 특정 label을 가진 node를 선호하거나 반드시 선택하도록 만드는 규칙입니다. GPU가 있는 node, 고성능 disk가 있는 node, 특정 운영체제나 architecture가 필요한 workload에 사용할 수 있습니다. required 조건은 맞는 node가 없으면 Pod가 배치되지 않고, preferred 조건은 가능하면 맞추되 다른 node도 사용할 수 있습니다. hardware 요구와 단순한 선호를 구분하지 않으면 장애 때 불필요하게 많은 Pod가 Pending이 될 수 있습니다.

pod affinity는 다른 Pod와 가까이 배치하고 싶을 때, pod anti-affinity는 같은 종류 Pod를 멀리 배치하고 싶을 때 사용합니다. cache를 사용하는 application과 같은 zone에 cache를 두어 network 지연을 줄이는 사례는 affinity가 될 수 있습니다. 반대로 동일한 API replica를 같은 hostname에 두지 않으려면 anti-affinity를 고려할 수 있습니다. 그러나 anti-affinity는 대규모 cluster에서 scheduler 계산과 배치 제약을 늘릴 수 있으므로, 단순 균형에는 topology spread가 더 읽기 쉬운 선택일 수 있습니다.

두 기능은 경쟁 관계가 아니라 표현하는 의도가 다릅니다. topology spread는 한 묶음의 분포 차이를 수치로 제어하고, anti-affinity는 특정 Pod 쌍이 함께 놓이지 않게 합니다. “각 zone에 대략 고르게”가 목적이면 spread가 자연스럽고, “primary와 standby를 절대 같은 host에 두지 않는다”처럼 명확한 금지가 목적이면 anti-affinity가 이해하기 쉽습니다. 요구사항을 문장으로 먼저 적은 뒤 맞는 도구를 고릅니다.

## taint와 toleration은 전용 자원을 지키는 장치다

taint는 node에 “특정 Pod만 여기 올 수 있다”는 성격을 부여합니다. `NoSchedule` taint가 있는 node에는 해당 taint를 견디는 toleration이 있는 Pod만 새로 배치될 수 있습니다. GPU node, 보안이 강화된 node, 배치 작업 전용 node처럼 비싼 또는 민감한 자원을 일반 workload가 차지하지 않게 할 때 유용합니다. toleration은 그 node를 반드시 선택한다는 뜻이 아니라, 배치될 수 있는 자격을 얻는다는 뜻입니다.

전용 node를 제대로 사용하려면 toleration만 넣지 말고 node affinity도 함께 고려합니다. toleration만 있으면 Pod는 일반 node에도 배치될 수 있고, 전용 node의 의미가 약해질 수 있습니다. 반대로 required affinity와 taint를 너무 많이 조합하면 작은 장애에도 대체 node가 없어집니다. 전용 자원의 목적, 최소 node 수, 확장 계획, 장애 시 우선순위를 문서로 남겨야 합니다.

taint는 node가 비정상일 때도 사용됩니다. Kubernetes는 node의 disk pressure, memory pressure, network unavailable 같은 상태를 taint로 표현할 수 있고, Pod의 toleration 설정에 따라 eviction 또는 재배치 행동이 달라질 수 있습니다. 모든 taint를 무조건 tolerate하면 손상된 node에 workload를 오래 남길 위험이 있습니다. 시스템 taint와 팀이 만든 전용 node taint를 구분해 검토합니다.

## 구체적 업무 예시: 세 zone의 결제 API

세 개 zone에 node가 있는 cluster에서 결제 API를 여섯 replica로 실행한다고 하겠습니다. API는 stateless이지만 database와 결제 제공자를 호출하며, 한 zone이 사라져도 남은 zone에서 최소 기능을 제공해야 합니다. 팀은 zone 기준 spread와 hostname 기준 spread를 두고, `maxSkew`를 보수적으로 정합니다. 동시에 HPA의 최소 replica와 최대 replica를 zone 수, 각 zone의 node 여유, Pod request를 기준으로 정합니다.

배포 전에는 한 zone의 node를 cordon·drain하는 staging 시나리오를 만듭니다. 남은 zone에 Pod가 예정대로 재배치되는지, scheduler event에 unschedulable 이유가 없는지, readiness가 통과하기 전에 traffic이 가지 않는지 확인합니다. zone 장애 후 남은 replica가 database connection, 외부 결제 rate limit, CPU를 감당하는지도 관찰합니다. Pod 개수만 정상으로 돌아왔다는 사실은 결제 흐름이 정상이라는 증거가 아닙니다.

한 zone에만 node가 남은 작은 개발 cluster에서는 같은 강제 규칙이 개발을 막을 수 있습니다. 이때 production과 똑같은 constraint를 무조건 복사하기보다 environment별 node topology 차이를 문서화하고, production manifest 검증은 별도 cluster 또는 admission 검사로 보완합니다. 개발 편의 때문에 production의 분산 규칙을 완전히 제거하면 실제 배포에서만 Pending 문제가 드러날 수 있습니다.

## 스케줄링 실패를 진단하는 순서

Pod가 Pending이면 먼저 `kubectl describe pod`의 event를 읽어 scheduler가 제시한 이유를 확인합니다. CPU나 memory request를 수용할 node가 없는지, taint를 tolerate하지 않는지, required affinity가 맞는 node가 없는지, topology spread의 `DoNotSchedule` 제약을 만족하지 못하는지 구분합니다. event를 보지 않고 replica 수나 pool size부터 바꾸면 잘못된 계층을 고칠 수 있습니다.

그 다음 node label의 실제 값을 확인합니다. zone label 이름을 잘못 썼거나 일부 node에 label이 빠져 있으면 규칙은 의도와 다르게 동작합니다. label은 단순한 문자열이지만 scheduler에게는 인프라 구조를 설명하는 데이터입니다. cluster를 증설하거나 node group을 교체할 때 label 정책과 자동화가 유지되는지 확인해야 합니다.

마지막으로 분포를 시간에 따라 봅니다. 새 배포 때만 몰리는지, autoscaling 뒤 특정 zone에 집중되는지, node maintenance 뒤 균형이 회복되는지 확인합니다. scheduler는 이미 실행 중인 Pod를 계속 옮겨 완벽한 균형을 만드는 도구가 아닙니다. 균형을 회복하려고 무리하게 Pod를 재시작하면 가용성을 해칠 수 있으므로, 변경과 재배치의 비용을 함께 판단합니다.

## 한계와 적용 기준 Q&A

### Q. Pod를 zone마다 정확히 같은 수로 강제해야 하나요?

A. 꼭 그렇지는 않습니다. replica 수가 zone 수로 나누어지지 않거나 node 자원이 다르면 완벽한 동일 분포는 불가능할 수 있습니다. 중요한 것은 한 domain의 장애가 허용 가능한 범위를 넘는지와, 불균형을 어느 정도까지 허용할지입니다. `maxSkew`와 최소 replica를 서비스 목표에 맞춰 정합니다.

### Q. anti-affinity만 쓰면 topology spread는 필요 없나요?

A. hostname 단위로 한 Pod씩만 두려는 작은 workload에는 anti-affinity가 충분할 수 있습니다. 하지만 zone별 개수 차이를 제어하거나 replica 수가 많아질 때에는 topology spread가 의도를 더 직접적으로 표현할 수 있습니다. 두 규칙을 함께 쓸 때는 Pending 가능성과 scheduler 비용을 staging에서 확인합니다.

### Q. Pod가 고르게 배치되면 장애 대비가 끝난 건가요?

A. 아닙니다. traffic routing, node와 zone의 여유 용량, database와 message broker의 장애 도메인, secret과 DNS, deployment rollback도 함께 확인해야 합니다. Pod 분산은 하나의 방어선이며 전체 복원력 설계의 일부입니다.

## 도입 순서와 점검표

먼저 workload별로 어떤 장애 도메인을 피해야 하는지 적습니다. stateless API는 hostname과 zone 분산이 필요할 수 있고, batch job은 비용 효율이 더 중요할 수 있으며, 단일 replica 도구는 분산 규칙보다 빠른 복구와 백업이 중요할 수 있습니다. 같은 template를 모든 namespace에 적용하지 말고, 영향도와 복구 목표를 기준으로 분류합니다.

다음으로 현재 node label, zone별 node 수와 자원, Pod request, HPA 최소·최대 replica, PDB를 함께 점검합니다. constraint를 적용한 뒤에는 정상 배포, node drain, zone 축소, autoscaling, 이미지 pull 지연 같은 시나리오에서 Pending event와 사용자 지표를 확인합니다. 설정 값만 lint하는 것으로는 실제 용량 부족을 발견하기 어렵습니다.

좋은 배치 정책은 Pod를 가능한 한 넓게 흩는 정책이 아니라, 서비스가 감당해야 할 실패를 넘지 않도록 분산하면서도 평상시에 배포 가능한 정책입니다. topology, affinity, taint의 목적과 한계를 기록하면 스케줄링은 예측하기 어려운 마법이 아니라 팀이 조정할 수 있는 인프라 계약이 됩니다.

## 정책 충돌을 읽는 방법

실제 manifest에는 topology spread 하나만 있는 경우보다 resource request, node affinity, pod anti-affinity, taint toleration, PVC의 zone 제약, PDB가 함께 있는 경우가 많습니다. scheduler는 이 조건을 한 줄씩 독립적으로 만족시키는 것이 아니라, 모든 필수 조건을 동시에 만족하는 node 후보를 찾습니다. 따라서 조건 하나는 합리적으로 보여도 조합 결과가 후보를 하나도 남기지 않을 수 있습니다. 새 정책을 추가하기 전에 기존 workload가 이미 어떤 제약을 쓰는지 확인해야 합니다.

예를 들어 특정 zone에 있는 block storage volume을 쓰는 Pod는 해당 zone 밖 node에 배치되지 못할 수 있습니다. 여기에 모든 zone에 고르게 퍼져야 한다는 강한 topology 규칙을 추가하면 volume의 위치 때문에 Pod가 Pending이 될 수 있습니다. 해결책은 규칙을 무조건 약하게 만드는 것이 아니라, stateful workload의 저장소 장애 도메인과 복제 전략을 먼저 이해하는 것입니다. stateless API와 stateful database에 같은 배치 template를 쓰지 않는 이유도 여기에 있습니다.

node selector와 required node affinity는 하드웨어 요구가 분명할 때만 강하게 사용합니다. 어떤 team이 과거에 만든 임시 label을 required 조건으로 남겨 두면 node group 교체 뒤 새 Pod가 모두 Pending이 될 수 있습니다. label의 소유자, 생성 자동화, 폐기 절차를 정하고, 사용하지 않는 label 조건을 정기적으로 지웁니다. scheduler의 실패는 종종 복잡한 알고리즘 문제가 아니라 오래된 인프라 메타데이터 문제입니다.

anti-affinity도 과도하면 cluster의 bin packing을 나쁘게 만들 수 있습니다. 각 node에 동일 Pod를 한 개만 두도록 강제한 상태에서 replica 수가 node 수보다 많아지면 새 Pod는 반드시 Pending입니다. HPA가 traffic을 감지해 replica를 늘려도 node 수가 따라오지 않으면 scale-out은 사용자 지연을 해결하지 못합니다. autoscaler, node provisioner, Pod request, 배치 정책을 함께 검토해야 하는 이유입니다.

## 우선순위와 선점의 영향

cluster 자원이 부족할 때 모든 Pod가 같은 중요도를 갖지는 않습니다. 주문 처리나 인증처럼 핵심 경로의 Pod와 일시적인 분석 작업, 개발용 작업이 경쟁하면 더 중요한 workload가 먼저 실행될 수 있는 기준이 필요합니다. Kubernetes priority class와 preemption은 이런 상황을 다루는 도구가 될 수 있지만, 낮은 우선순위 Pod를 밀어내는 행동은 그 workload의 작업 손실과 재시도를 만들 수 있습니다. 우선순위는 이름이 아니라 사용자 영향과 복구 비용으로 정합니다.

높은 우선순위 Pod에 강한 topology constraint까지 주면 필요한 node가 없을 때 기존 Pod를 축출하고도 원하는 배치를 만들지 못할 수 있습니다. 따라서 선점은 가용성을 보장하는 만능 해법이 아닙니다. 중요한 서비스에는 충분한 여유 capacity와 적절한 최소 replica를 먼저 두고, priority는 예외 상황에서의 마지막 보호 장치로 사용합니다. 개발·배치 작업이 핵심 API의 node를 모두 차지하지 않도록 namespace quota와 limit range도 함께 고려합니다.

우선순위 정책은 장애 훈련에서 검증합니다. cluster 자원이 의도적으로 부족한 상태에서 핵심 Pod가 새 version으로 rollout될 때 무엇이 Pending이 되는지, 어떤 Pod가 축출되는지, PDB가 어떻게 작동하는지 확인합니다. 이 실험은 고객 traffic이 없는 staging이나 격리된 cluster에서 해야 하며, 운영 node를 무작정 압박해서는 안 됩니다. 결과를 runbook에 남기면 실제 용량 사고에서 즉흥적으로 수치를 바꾸는 일을 줄일 수 있습니다.

## 서비스별 배치 요구를 문서화하기

모든 Deployment에 적용할 수 있는 단 하나의 `maxSkew` 값은 없습니다. 외부 요청을 처리하는 API는 hostname과 zone 분산이 중요할 수 있고, queue worker는 처리량과 node 비용이 더 중요할 수 있으며, cron job은 동시에 여러 개가 실행되지 않는 것이 우선일 수 있습니다. 각 서비스의 RTO(Recovery Time Objective, 복구 목표 시간)와 RPO(Recovery Point Objective, 복구 시 허용 데이터 손실), 허용 가능한 단일 장애 범위를 정리하면 배치 규칙의 이유를 설명할 수 있습니다.

문서에는 단지 YAML 조각만 넣지 않습니다. 어떤 label을 장애 도메인으로 믿는지, 어느 조건은 필수이고 어느 조건은 선호인지, zone 하나가 사라졌을 때 최소 몇 replica가 남아야 하는지, capacity가 부족할 때 어떤 기능을 줄일지 적습니다. 이 정보가 없으면 다음 운영자가 값 하나를 “배포를 막는 불편한 설정”으로 보고 삭제할 수 있습니다. 반대로 근거가 없는 강한 제약도 주기적으로 완화할 수 있어야 합니다.

새 서비스가 cluster에 들어올 때 배치 검토를 release checklist에 넣습니다. request와 limit, 최소 replica, PDB, topology key, toleration, node affinity, 저장소 종류, HPA 최대값, 장애 시 dependency 한도를 한 화면에서 확인합니다. 서로 다른 팀이 ownership을 나눠 가진 항목이라면 담당자와 변경 경로도 연결합니다. 배치 정책은 플랫폼 팀의 YAML만으로 끝나지 않고 application의 연결 수와 timeout, 사용자 경험에 영향을 줍니다.

## 관찰과 경보의 최소 단위

정상 상태의 분포를 먼저 기록하지 않으면 불균형을 판단하기 어렵습니다. zone별·node별 Pod 수, Pending Pod 수와 지속 시간, scheduling latency, unschedulable reason, node allocatable 대비 request 비율, eviction 수를 dashboard에 둡니다. 특정 zone에 Pod가 많아졌다는 사실만으로 알람을 울리기보다, 정의한 max skew를 넘어섰는지와 실제 replica 가용성이 줄었는지 함께 봅니다.

Pending 경보는 특히 중요합니다. 새 Pod가 잠시 Pending인 것은 image pull이나 scheduler 처리 중 정상일 수 있지만, 일정 시간 이상 지속되면 capacity·label·taint·constraint 충돌을 조사해야 합니다. 경보에는 단순한 개수뿐 아니라 namespace, workload, event의 마지막 이유, 최근 deployment 시각을 연결하면 담당자가 바로 다음 확인을 할 수 있습니다. 경보가 사람에게 “Pod가 이상하다”만 말하면 조치 시간이 길어집니다.

node 장애 뒤 재배치 속도도 추세로 봅니다. node not ready 시각, Pod termination, 새 Pod scheduling, image pull, readiness 통과, load balancer 등록까지의 시간을 분리하면 어느 단계가 복구를 늦추는지 알 수 있습니다. topology 정책을 바꾼 뒤 이 시간이 길어졌다면 분산은 좋아졌지만 복구 목표를 해칠 수 있습니다. 정책의 효과는 배치 화면뿐 아니라 사용자 요청의 오류율과 지연으로 검증합니다.

## 변경과 롤백의 기준

topology rule을 `ScheduleAnyway`에서 `DoNotSchedule`로 바꾸는 것은 단순한 설정 조정이 아니라 배포 실패의 가능성을 높이는 변경입니다. 먼저 canary workload에 적용해 node 수와 zone label이 충분한지 확인하고, 다음 rollout에서 Pending이 생겼을 때 어떤 조건을 완화하거나 어떤 node group을 늘릴지 미리 정합니다. rollback은 constraint를 삭제하는 것만이 아니라 새 Pod가 다시 어느 domain에 몰릴지 확인하는 절차여야 합니다.

node label 변경도 단계적으로 합니다. 기존 label을 제거하기 전에 이를 selector나 topology key로 쓰는 workload를 찾고, 새 label을 모든 대상 node에 추가한 뒤 분포를 확인합니다. label 이름의 오타는 manifest 검증만으로 발견되지 않을 수 있으므로, 실제 scheduler event와 node inventory를 대조합니다. infrastructure as code에 label 정책을 넣고 리뷰하면 콘솔에서 임시로 바꾼 값이 남는 일을 줄일 수 있습니다.

장애 중에는 완벽한 균형보다 서비스를 실행 가능한 상태로 만드는 판단이 필요할 수 있습니다. zone 전체가 사라져 강한 분산을 만족할 수 없다면 임시로 policy를 완화할지, 일부 기능을 중단할지, 다른 region으로 전환할지 선택해야 합니다. 이런 선택은 incident 때 처음 결정하면 위험합니다. 서비스 중요도와 데이터 정합성, 남은 capacity를 기준으로 한계와 승인자를 미리 runbook에 적어 둡니다.

배치 전략의 품질은 “모든 Pod가 항상 고르게 보인다”가 아니라, 예상한 장애에서 왜 어떤 Pod가 어디에 실행되고 어떤 위험이 남는지 설명할 수 있는 상태입니다. 작은 cluster의 현실과 중요한 서비스의 목표를 숨기지 않고 문서화하면, scheduler 설정은 복잡한 예외의 집합이 아니라 복원력 설계의 일부가 됩니다.

## cluster 규모가 작을 때의 현실적인 선택

세 개 zone을 전제로 만든 규칙을 두 개 node뿐인 cluster에 그대로 적용하면, 첫 배포부터 Pending이 생길 수 있습니다. 이 문제를 해결하려고 production 정책을 지우기보다 환경의 목적을 구분합니다. 개발 cluster는 빠른 기능 검증이 목적이라면 preferred 분산 또는 더 작은 replica 수를 쓸 수 있습니다. 반면 production manifest는 별도 검증 단계에서 실제 zone 수와 request를 가진 cluster에 적용해 배치 가능성을 확인합니다. 환경마다 차이가 있다는 사실을 숨기지 않는 것이 중요합니다.

단일 zone cluster라면 zone spread는 가용성 향상을 주지 않습니다. 이 경우 hostname 분산, node 교체 속도, 충분한 spare capacity, 이미지 배포 시간, 백업과 복구 절차가 더 현실적인 방어선이 됩니다. multi-zone으로 확장할 계획이 있다면 label과 manifest 구조를 미리 준비할 수 있지만, 존재하지 않는 zone을 요구하는 constraint는 현재 장애를 만드는 설정일 뿐입니다. 미래의 구조와 현재의 실행 가능성을 분리합니다.

node가 하나뿐인 test 환경에서는 anti-affinity가 테스트 자체를 막을 수 있습니다. 기능 테스트가 목적이라면 해당 환경에서만 scheduler 정책을 완화하고, policy가 완화됐다는 표시를 테스트 결과에 남깁니다. production 복원력 검증은 더 적절한 환경에서 별도로 수행합니다. 한 환경의 통과 결과를 다른 환경의 가용성 증거로 과장하지 않는 것이 운영에서 중요합니다.

## stateful workload를 따로 생각하기

database, message broker, 검색 index처럼 data를 갖는 workload는 Pod 배치만으로 안전해지지 않습니다. Pod가 다른 zone에 있어도 volume이 한 zone에 묶여 있거나 replication이 늦으면 장애 도메인이 남습니다. StatefulSet, volume binding mode, storage class, replication factor, quorum, backup 경로를 함께 검토합니다. stateless API에 성공한 spread 설정을 stateful workload에 복사하면 데이터 복구 조건을 놓칠 수 있습니다.

stateful Pod는 재배치 시간이 길 수 있습니다. 새 node에 Pod가 떠도 volume attach, 데이터 동기화, leader election, health check가 끝날 때까지 service endpoint가 되지 않을 수 있습니다. PDB와 anti-affinity를 사용할 때에는 동시에 잃어도 되는 replica 수뿐 아니라 다시 준비되는 시간과 남은 replica가 처리할 수 있는 부하를 계산합니다. 안정성을 높이는 규칙이 maintenance와 recovery 시간을 지나치게 늘리지 않는지 검증합니다.

특히 quorum 시스템에서는 replica를 세 domain에 흩어도 network partition 때 어떤 쪽이 쓰기를 계속할지 별도 규칙이 필요합니다. Kubernetes scheduler는 데이터 정합성이나 leader 선출의 올바름을 보장하지 않습니다. application 또는 database 제품의 복제 설계와 cluster 배치를 연결해 문서화해야 합니다. Pod가 고르게 보인다는 화면만으로 데이터 내구성을 판단하지 않습니다.

## 네트워크와 traffic 경로의 확인

Pod가 여러 zone에 배치돼도 client traffic이 한 zone의 ingress나 load balancer target에 몰리면 분산 효과는 작아질 수 있습니다. service endpoint와 ingress, external load balancer가 ready Pod를 어떻게 선택하는지 확인하고, cross-zone traffic 비용과 지연도 고려합니다. locality를 지나치게 강제하면 한 zone의 부하가 높은데도 다른 zone의 여유를 쓰지 못할 수 있습니다. 배치와 routing은 함께 설계해야 합니다.

network policy도 스케줄링 뒤의 실제 연결을 막을 수 있습니다. 새 zone에 Pod가 정상적으로 배치됐지만 database나 DNS, metrics endpoint에 연결하지 못하면 readiness가 통과하지 않을 수 있습니다. 장애 훈련에는 node와 zone의 제거뿐 아니라 필요한 dependency로의 network 연결, certificate와 secret 전달, service discovery를 포함합니다. scheduler event가 정상이라는 사실과 application이 사용 가능하다는 사실은 다릅니다.

cross-zone dependency가 있는 경우에는 latency 증가가 timeout과 retry를 유발할 수 있습니다. timeout이 짧은 API는 멀리 배치된 Pod에서만 간헐적으로 실패할 수 있고, retry가 겹치면 남은 zone의 부하가 커집니다. 배치 변경 뒤에는 zone별 요청 수, latency, 오류율을 비교하고, 네트워크 경로가 바뀐 사실을 배포 기록에 남깁니다. 분산 정책의 효과를 CPU 그래프만으로 평가하지 않습니다.

## 자동화와 검토 절차

manifest 검증에는 topology key의 존재 여부, label selector가 실제 workload label과 맞는지, `maxSkew`와 `whenUnsatisfiable` 값이 의도한지 확인하는 규칙을 넣을 수 있습니다. 그러나 정적 검증만으로 node 수와 future capacity를 알 수는 없습니다. CI에서는 schema와 policy를 검사하고, staging에서는 scheduler가 실제 Pod를 어디에 두는지, 운영에서는 변화 추세와 장애 훈련 결과를 확인하는 식으로 계층을 나눕니다.

변경 리뷰에서는 “이 constraint가 어떤 failure domain을 줄이는가”, “조건을 만족하지 못하면 Pod가 Pending이어도 되는가”, “HPA 최대 replica까지 확장하면 node가 충분한가”, “한 zone이 사라지면 어떤 기능을 포기하는가”를 묻습니다. 답이 없다면 값만 복사한 설정일 가능성이 큽니다. 작은 설명을 manifest 주석이나 운영 문서에 남기면 이후 변경자가 의도를 파악할 수 있습니다.

정기적으로 실제 분포와 문서의 가정도 대조합니다. node group이 증설되거나 zone이 추가되고, workload label이 바뀌며, 새 sidecar가 request를 늘리면 과거의 배치 판단이 더 이상 맞지 않을 수 있습니다. 매번 완벽하게 재설계할 필요는 없지만, 주요 platform 변경과 서비스 확장 시 topology 검토를 다시 수행하는 습관이 필요합니다.

## 최종 적용 기준

topology spread와 affinity, taint가 적합한 workload는 여러 replica가 있고, 실제 인프라에 구분 가능한 장애 도메인이 있으며, 한 domain 손실 뒤에도 남은 capacity로 핵심 기능을 제공해야 하는 서비스입니다. 반대로 단일 replica 도구, 개발용 짧은 job, 저장소 제약이 강한 stateful workload는 같은 규칙을 그대로 적용하기보다 복구·백업·저장소 설계를 우선해야 할 수 있습니다.

안전한 시작은 중요 API 하나에 hostname 기준의 선호 분산을 적용하고, 정상 배포와 node drain에서 event와 사용자 지표를 확인하는 것입니다. 그 뒤 zone 분산, 강한 제약, 전용 node를 단계적으로 추가합니다. 각 단계에서 Pending 가능성, 장애 회복 시간, 비용, dependency capacity를 기록하면 복잡한 스케줄링 규칙도 설명 가능한 운영 정책으로 성장합니다.

### 배치 변경 뒤 확인할 실제 시나리오

첫째, 새 image를 배포할 때 이전 Pod와 새 Pod가 어느 node와 zone에 놓이는지 확인합니다. update strategy가 허용하는 unavailable 수와 surge 수가 배치 제약, PDB와 충돌하지 않아야 합니다. 새 Pod가 readiness를 통과하지 못하면 이전 Pod를 너무 빨리 줄이지 않는지, rollout이 멈췄을 때 사람이 어떤 event와 log를 봐야 하는지도 점검합니다. 배포가 완료됐다는 표시는 replica 수가 같아졌다는 뜻일 뿐, 분산과 사용자 요청이 정상이라는 뜻은 아닙니다.

둘째, node 하나를 계획적으로 drain했을 때 남은 node의 request 여유와 topology 분포를 봅니다. Pod가 다른 node에 재배치돼도 같은 zone에 몰릴 수 있고, image pull 때문에 준비 시간이 길어질 수 있습니다. 중요한 서비스는 drain 동안 허용 가능한 오류율과 지연, 작업 중단 여부를 정하고, 필요하면 maintenance 시간대와 사전 scale-out을 계획합니다. node 유지보수는 scheduler 설정을 검증할 수 있는 현실적인 훈련 기회입니다.

셋째, HPA가 replica를 최대로 늘리는 부하 상황을 확인합니다. 최소 replica에서는 균형이 좋아 보여도 최대 replica에서 node 수가 부족하거나 `maxSkew` 제약 때문에 Pending이 쌓일 수 있습니다. 이때 application은 어떤 backpressure를 주는지, queue나 database connection이 버티는지, cluster autoscaler가 새 node를 준비하는 시간은 얼마인지 함께 봅니다. topology 정책은 정상 규모뿐 아니라 최대 규모에서 검증해야 합니다.

넷째, zone 또는 node group 하나를 잃는 가정을 문서화합니다. 남은 zone에 충분한 capacity가 없다면 모든 replica를 즉시 복구한다는 목표는 현실적이지 않을 수 있습니다. 핵심 API를 우선하고 덜 중요한 batch나 분석 기능을 제한하는 순서, 사용자 안내, 다른 region 전환 조건을 정하면 장애 때 분산 규칙을 무작정 삭제하는 일을 줄일 수 있습니다. 기술 설정과 서비스 우선순위는 같은 복원력 계획의 일부입니다.

다섯째, 실제 장애가 없을 때에도 scheduler 관련 변경을 작은 단위로 검토합니다. node label 하나, request 증가, 새 sidecar, zone 확장처럼 사소해 보이는 변경이 배치 후보와 장애 도메인을 바꿀 수 있습니다. manifest diff와 node inventory, 최근 Pending event를 함께 확인하고 변경 뒤 분포를 관찰하면, 대규모 incident가 되기 전에 가정을 수정할 수 있습니다. 이 반복은 특별한 플랫폼 작업이 아니라 서비스 배포의 일상적인 품질 점검이 되어야 합니다.

여섯째, 성공한 배치 결과도 기준선으로 남깁니다. 정상 배포에서 zone별 replica 수와 node별 request, readiness까지 걸린 시간을 기록해 두면, 다음 변경 뒤 불균형과 복구 지연을 비교할 수 있습니다. 기준선은 완벽한 숫자를 강요하는 표가 아니라, 환경 변화가 서비스의 가용성 가정에 어떤 영향을 주었는지 발견하는 출발점입니다.

이 기록에는 당시의 node 수와 zone 구성, workload의 최소·최대 replica, 적용한 constraint version도 포함합니다. 그래야 몇 달 뒤 cluster가 커지거나 서비스 request가 바뀐 뒤에도 과거 결과를 같은 조건으로 해석할 수 있습니다. 운영의 반복 가능한 판단은 기억보다 이러한 작은 사실 기록에서 시작됩니다.

<h3 class="references-heading">참고 자료</h3>

- [Kubernetes Documentation: Pod Topology Spread Constraints](https://kubernetes.io/docs/concepts/scheduling-eviction/topology-spread-constraints/)
- [Kubernetes Documentation: Assigning Pods to Nodes](https://kubernetes.io/docs/concepts/scheduling-eviction/assign-pod-node/)
