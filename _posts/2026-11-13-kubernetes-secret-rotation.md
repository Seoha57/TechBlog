---
layout: post
title: "Kubernetes Secret 회전을 설계하는 법: 만료·배포·재시작·감사의 연결"
categories: [Infrastructure]
tags: [kubernetes, secret, security, rotation, workload-identity, infrastructure]
description: "Kubernetes Secret의 역할과 한계를 이해하고, 비밀 값 교체가 애플리케이션 반영·권한·감사까지 안전하게 이어지도록 설계하는 방법을 설명합니다."
---

## 먼저 답하기

### Q. Secret 값을 바꾸면 Pod가 자동으로 새 비밀 값을 사용하나요?

A. 사용 방식에 따라 다릅니다. 환경 변수로 주입한 Secret은 이미 시작된 process의 환경 변수가 바뀌지 않으므로 Pod 재시작 또는 애플리케이션의 명시적 reload가 필요합니다. volume으로 mount한 Secret은 Kubernetes가 파일을 갱신할 수 있지만, 애플리케이션이 그 파일을 다시 읽는지와 갱신 지연을 별도로 확인해야 합니다. 따라서 Secret 객체의 변경과 실제 서비스가 새 credential을 쓰는 일을 같은 사건으로 보면 안 됩니다.

### Q. 비밀 값을 주기적으로 바꾸면 무조건 더 안전한가요?

A. 회전(rotation)은 유출된 credential의 사용 가능 시간을 줄일 수 있지만, 무계획 회전은 인증 실패와 서비스 중단을 만들 수 있습니다. 새 값 발급, 저장, workload 반영, 기존 값의 유예 기간, 접근 로그 확인, 폐기 순서가 연결되어야 합니다. 짧은 회전 주기보다 실제로 검증된 회전 절차와 최소 권한이 더 중요합니다.

## 먼저 알아둘 기반 기술

### Secret, credential, encryption at rest

Kubernetes Secret은 password, API token, TLS private key, database connection credential처럼 민감한 값을 Pod에 전달하기 위한 API 객체다. ConfigMap처럼 보일 수 있지만 보안 성질이 자동으로 보장되는 금고는 아니다. 기본 표현이 Base64인 경우도 있으므로, Base64 인코딩을 암호화로 오해해서는 안 된다. cluster의 etcd에 Secret이 어떻게 암호화돼 저장되는지, 누가 Kubernetes API로 읽을 수 있는지, audit log가 남는지, backup에 포함되는지까지 확인해야 한다.

credential은 누군가 또는 어떤 workload가 외부 시스템에 접근할 수 있다는 증명이다. database 사용자 password, cloud access key, OAuth client secret, mTLS 인증서가 대표적이다. 값 자체뿐 아니라 scope와 만료 시각이 보안에 영향을 준다. 모든 database에 접근 가능한 장기 password 하나보다, 특정 서비스가 필요한 schema만 읽고 짧게 쓸 수 있는 identity가 노출 범위를 줄인다.

### control plane과 data plane의 차이

Secret YAML을 `kubectl apply` 하는 행위는 Kubernetes control plane의 상태를 바꾸는 일이다. 그러나 실제 database login이나 외부 API 호출은 Pod 안 process가 수행하는 data plane의 동작이다. control plane에서 object의 resourceVersion이 새 값으로 바뀌었다고 해서 data plane 연결이 새 credential으로 바뀐 것은 아니다. 회전 설계는 이 둘 사이의 반영 지연과 실패를 관찰해야 한다.

## Secret 회전이 필요한 이유와 범위

credential은 source code, CI 로그, 개발자 노트북, 잘못된 webhook, backup, 과도한 RBAC(Role-Based Access Control) 권한을 통해 노출될 수 있다. 회전은 노출 사실을 알았을 때 옛 값을 무효화하고, 정상적인 경우에도 장기 credential이 영원히 유효하지 않게 만드는 통제다. 하지만 모든 값을 같은 날짜에 바꾸면 장애 원인을 찾기 어려우므로 비밀의 위험·사용량·갱신 방식에 따라 우선순위를 나눈다.

먼저 목록을 만든다. 어떤 Secret이 어느 namespace에 있고, 어떤 Deployment·CronJob·Ingress가 사용하는지, 값의 발급자와 만료 정책은 무엇인지, 외부 시스템에서 두 개의 동시 credential을 허용하는지 적는다. 이름만 보고 판단하지 말고 실제 volume mount, `envFrom`, CI variable, Helm values, application 설정 파일을 함께 확인한다. 이 inventory가 없으면 오래된 값을 폐기할 때 예상하지 못한 batch나 운영 도구가 실패한다.

회전 대상은 password만이 아니다. TLS certificate, webhook signing secret, image registry credential, encryption key reference, OAuth refresh token도 만료와 교체 방식이 다르다. private key처럼 동시에 두 값을 활성화하기 어려운 항목과, API key처럼 구·신 키를 겹쳐 쓸 수 있는 항목은 rollout 전략이 달라진다. 하나의 회전 runbook으로 모두 처리하려 하지 말고, 비밀 유형별로 필요한 준비와 rollback 조건을 분리한다.

## 안전한 회전 순서: 만들기, 배포하기, 폐기하기

외부 provider가 새 credential과 기존 credential의 동시 유효를 지원한다면, 가장 안전한 기본 순서는 새 값을 먼저 발급하고 제한된 workload에 배포한 뒤 정상 연결을 확인하고 마지막에 옛 값을 폐기하는 것이다. database 계정이라면 새 계정을 필요한 권한으로 만들고, 새 Secret을 만든 뒤 canary Pod 한두 개가 실제 query를 수행하는지 확인한다. 기존 workload를 한꺼번에 재시작하기 전에 연결 실패율과 인증 오류를 관찰하면 영향 범위를 줄일 수 있다.

Secret 이름을 고정하고 data만 바꾸는 방식과, version이 들어간 새 Secret을 만들어 workload 참조를 바꾸는 방식에는 trade-off가 있다. 고정 이름은 manifest가 단순하지만 어느 Pod가 어느 revision을 쓰는지 추적하기 어렵다. versioned 이름은 rollout과 rollback의 대상을 분명하게 만들지만 참조를 갱신할 관리가 필요하다. 팀의 배포 도구와 애플리케이션 reload 방식에 맞춰 하나를 선택하고, 혼합 사용으로 운영자가 추측하게 만들지 않는다.

옛 값을 바로 지우지 않는 유예 기간은 rollback에는 도움이 되지만 유출 위험도 남긴다. 유예 기간 동안에는 옛 값 사용 로그가 없는지 확인하고, 정해진 종료 시각에 폐기하며, 폐기 실패나 계속된 사용을 경보로 올린다. "나중에 삭제"는 회전 완료가 아니다. 발급·반영·검증·폐기 네 단계가 모두 증거로 남아야 한다.

## 환경 변수와 volume mount의 반영 차이

환경 변수는 process 시작 시 한 번 읽히는 값이다. Secret을 수정해도 이미 실행 중인 컨테이너의 `DB_PASSWORD`는 바뀌지 않는다. rolling restart를 할 때 readiness probe, PodDisruptionBudget, connection draining을 고려하지 않으면 credential 회전 자체가 배포 장애가 될 수 있다. 재시작 전 새 credential이 외부 시스템에서 실제로 유효한지 작은 canary로 확인하고, workload가 여러 replica를 갖는다면 점진적으로 바꾼다.

volume mount는 kubelet이 Secret 업데이트를 file system에 반영할 수 있으나, 애플리케이션이 파일을 메모리에 캐시했다면 여전히 이전 값을 사용할 수 있다. 일부 서버는 SIGHUP 또는 자체 reload endpoint로 설정을 다시 읽고, 일부 client library는 connection pool을 재생성해야 한다. 그래서 "파일이 바뀌었음"과 "새 연결이 생성되었음"을 별도 probe로 확인한다. 임의로 Pod 안에서 file을 수정하는 방식은 controller가 다시 덮어쓸 수 있고 선언형 상태도 깨뜨리므로 피한다.

## External Secrets와 workload identity의 위치

외부 secret manager를 Kubernetes와 연결하는 도구는 cloud key vault나 중앙 비밀 저장소의 값을 Secret으로 동기화할 수 있다. 이는 값의 source of truth를 한 곳에 두고 access audit, 만료, rotation policy를 이용하게 하지만, 동기화 controller와 provider 권한이라는 새 의존성을 만든다. controller가 멈췄을 때 마지막 값이 남는지, 새 값 반영이 지연되면 어떻게 알리는지, namespace가 다른 값을 읽지 못하게 하는지 설계해야 한다.

workload identity는 Pod가 장기 static key 대신 서비스 계정과 cloud identity 연계를 통해 짧은 수명의 token을 얻는 방식이다. 가능한 경우 database password를 Secret으로 복사하는 것보다 노출 시간을 줄일 수 있다. 그러나 모든 외부 서비스가 이런 identity를 지원하지 않고, federation 설정이 잘못되면 오히려 넓은 권한을 줄 수 있다. static Secret을 없애는 목표보다 어떤 workload가 어떤 resource에 어떤 시간 동안 접근하는지 설명 가능한 권한 모델을 만드는 것이 우선이다.

## 업무 예시: database credential 회전

주문 서비스가 database에 접근하는 장기 password를 쓰고 있다고 가정한다. 먼저 서비스 계정이 실제로 필요한 schema와 SQL 권한만 갖는지 확인한다. 새 database 계정 또는 새 password를 발급하고, Secret revision을 만들며, test namespace에서 migration·health check·대표 read/write를 실행한다. 그 다음 production의 canary replica에만 새 revision을 주입하고 authentication failure, connection pool 재생성, 주문 생성·조회 같은 대표 흐름을 확인한다.

정상이라면 rolling update로 나머지 replica를 교체한다. 이때 database의 최대 connection 수와 application의 retry 정책도 함께 본다. 모든 Pod가 새 credential을 쓴다는 증거는 Kubernetes object만이 아니라 database audit 또는 login log와 application metric에서 확인한다. 마지막으로 옛 credential을 비활성화하고, 실패하는 오래된 batch가 없는지 정해진 관찰 기간 동안 본다. 문제가 생기면 새 값을 즉시 폐기하는 대신, 아직 유효한 옛 revision으로 workload를 되돌릴 수 있도록 rollback 순서를 미리 정한다.

이 예시는 실제 운영 경험을 말하는 것이 아니라 절차를 설명하기 위한 것이다. 특정 database와 driver는 password 변경·connection caching 동작이 다를 수 있으므로, production 적용 전에는 해당 제품 문서와 격리 환경에서의 검증이 필요하다.

## 권한과 감사를 함께 설계하기

Secret을 읽는 권한은 Secret을 수정하는 권한과 분리하는 편이 안전하다. CI가 deployment manifest를 적용해야 한다고 해서 모든 namespace의 Secret 값을 조회할 필요는 없다. service account에는 필요한 namespace와 resource name으로 권한을 좁히고, 사람의 긴급 접근은 시간 제한과 audit log를 남긴다. `list` 권한이 있으면 이름과 metadata가 드러날 수 있으므로 필요한지 따져 본다.

audit log는 누가 어떤 Secret을 읽거나 수정했는지, rotation controller가 어느 시점에 동기화했는지, 배포 도구가 어떤 revision을 적용했는지 연결하는 데 쓴다. 다만 audit event에 Secret value가 들어가지 않도록 정책을 확인하고, 로그 저장소의 접근 권한도 보호한다. 감사가 잘 남는다고 해서 값 노출을 허용하는 것은 아니다.

## 실패와 rollback을 미리 다루기

새 credential이 권한 부족, 잘못된 endpoint, clock skew, provider propagation 지연 때문에 실패할 수 있다. 회전 작업의 실패 조건은 단순한 Pod crash만이 아니다. authentication retry가 늘어 latency가 올라가거나, batch가 조용히 재시도만 하거나, 일부 region의 workload만 이전 값을 쓰는 상황도 있다. rollout 중에는 login failure rate, readiness, 중요한 transaction 성공률, 새 Secret revision 사용 비율을 함께 관찰한다.

rollback은 값 자체를 로그나 ticket에 다시 붙여 넣는 것이 아니라, 안전하게 보관한 이전 revision을 참조하도록 workload를 되돌리고 연결 상태를 확인하는 절차여야 한다. 이미 옛 값을 폐기했다면 rollback이 불가능할 수 있으므로, 폐기 전에 새 값이 모든 경로에서 작동한다는 기준을 강하게 둔다. 보안 사고로 회전했다면 옛 credential을 다시 활성화하는 rollback은 허용되지 않을 수 있으므로, 가용성 rollback과 보안 격리의 우선순위를 incident 책임자가 판단해야 한다.

## 정기 점검과 회전 연습

만료 알림이 왔을 때 처음 runbook을 읽으면 회전은 쉽게 실패한다. 낮은 위험의 test credential부터 정기적으로 교체하고, 새 값 반영·Pod rollout·로그 확인·옛 값 폐기까지 시간을 기록한다. 이 연습에서 provider API 권한, controller health, application reload, audit 경로의 빈틈을 발견할 수 있다. 정기 회전은 보안을 위한 일정 작업이면서 장애 대응 훈련이기도 하다.

inventory에는 마지막 회전 시각, 다음 만료일, 소유 팀, 사용 workload, 회전 방식, 마지막 drill 결과를 남긴다. 만료 예정 credential을 알리는 경보와 controller 동기화 실패 경보를 분리하면 행동이 명확해진다. 모든 Secret을 같은 도구로 옮기거나 매일 회전할 필요는 없다. 위험과 영향이 큰 credential부터 실행 가능한 절차를 만들고 범위를 넓히는 편이 낫다.

## 배포 도구와 Git 저장소에서의 노출을 막기

Secret 회전은 종종 CI/CD(Continuous Integration and Continuous Delivery) pipeline에서 시작된다. 이때 가장 위험한 지름길은 새 password를 shell command, pull request, Helm values, build log에 직접 넣는 것이다. repository가 private여도 clone, fork, cache, artifact, 리뷰 화면을 통해 값이 넓게 퍼질 수 있다. secret manager가 발급한 값을 배포 시점에 참조하고, pipeline log에서는 값 대신 revision·secret reference·성공 여부만 출력하도록 한다. 이미 commit한 값은 단순 삭제 commit으로 기록에서 사라지지 않으므로 해당 credential을 즉시 폐기하고 history와 artifact를 별도로 처리해야 한다.

GitOps 방식에서는 선언형 manifest가 실제 cluster 상태를 만드는 출발점이 된다. 그렇다고 암호화하지 않은 Secret manifest를 저장소에 넣어도 된다는 뜻은 아니다. 암호화된 manifest나 external reference를 쓰더라도 복호화 key의 접근 경로, controller 권한, PR review의 가시성을 확인한다. 배포 도구가 새 Secret revision을 적용했는지, controller가 원래 값으로 되돌리지 않는지, rollback commit이 의도치 않게 이미 폐기한 credential을 가리키지 않는지도 점검한다.

## TLS 인증서와 API key의 서로 다른 회전

TLS certificate는 만료일과 private key·certificate chain의 조합을 다루며, Ingress나 proxy가 새 파일을 reload해야 한다. API key는 보통 provider가 두 개 이상의 active key를 허용하면 canary와 유예 기간을 두기 쉽다. 반면 webhook signing secret은 송신자와 수신자가 같은 시간에 새 값을 인식해야 할 수 있다. 비밀의 유형이 다르면 "새 값 발급 후 기존 값 폐기"라는 큰 원칙은 같아도 health check와 rollback이 달라진다.

인증서 회전에서는 endpoint handshake, hostname, chain, 만료일, 기존 연결 처리까지 확인하고, API key 회전에서는 provider 호출 성공률·quota·권한 scope를 확인한다. webhook은 구·신 signature를 일정 기간 모두 검증할지, event 재전송을 어떻게 처리할지 정해야 한다. 같은 Kubernetes Secret이라는 저장 형태만 보고 검증 기준을 통일하면 실제 사용 위치의 실패를 놓친다.

## multi-namespace와 multi-cluster의 경계

여러 namespace나 cluster가 같은 external credential을 공유하면 한 workload의 회전 실패가 다른 workload에도 영향을 준다. 공유가 꼭 필요하다면 소유 팀, namespace별 접근 권한, 동시에 rollout할 범위, 장애 시 우선순위를 명확히 한다. 가능하면 서비스별 identity와 provider 권한을 분리해 blast radius를 작게 만든다. development와 production이 같은 credential을 쓰는 구조는 개발 편의보다 노출·오작동의 비용이 크다.

multi-cluster 환경에서는 새 값이 모든 cluster에 동기화됐다고 가정하지 말고 cluster별 revision과 실제 연결 성공을 확인한다. 한 region은 새 값, 다른 region은 이전 값을 쓰는 동안 provider가 옛 값을 폐기하면 부분 장애가 생긴다. 단계별 rollout 목록과 완료 조건을 유지하고, 실패한 cluster만 안전하게 재시도할 수 있게 해야 한다.

## 회전 작업의 테스트와 승인 기준

회전을 production에 적용하기 전에는 새 credential 자체의 유효성, workload가 새 값을 읽는 방식, 실제 외부 연결, 옛 값의 폐기 효과를 각각 확인한다. unit test는 secret reference와 configuration parsing을 확인할 수 있고, integration test는 test provider에서 인증과 권한을 확인할 수 있으며, 배포 검증은 Pod의 revision과 대표 transaction을 확인한다. 어느 한 단계가 통과했다고 나머지를 생략하면 "값은 유효하지만 application이 reload하지 않음" 같은 결함을 놓친다.

승인 기준은 숫자 하나보다 관찰 가능한 상태로 쓴다. 예를 들어 새 revision을 쓰는 Pod 비율이 목표에 도달했고, 인증 실패율이 기준을 넘지 않으며, 주문 생성과 조회 같은 중요 흐름이 통과했고, database audit에서 옛 credential 사용이 없어야 폐기 단계로 간다고 적는다. 이 기준은 서비스마다 다르지만 미리 정해야 한다. 장애 중에 담당자의 감으로 판단하면 새 값이 일부만 반영된 상태에서 기존 credential을 삭제할 수 있다.

## 사람이 수행하는 break-glass 접근

자동 controller와 CI가 실패한 재해 상황에서는 사람이 임시 접근으로 credential을 교체해야 할 수 있다. 이 break-glass 절차는 평소 관리자 계정을 넓게 열어 두는 방식이 아니라, 승인된 담당자가 다중 인증과 audit를 거쳐 제한된 시간 동안 필요한 권한을 얻는 경로여야 한다. 누가 승인하는지, 어떤 namespace와 provider에 접근하는지, 사용 후 어떤 credential과 token을 회수하는지 정한다.

비상 절차도 정기적으로 연습한다. 실제 password를 문서에 저장하거나 메신저로 공유하지 않고, 비밀 관리 시스템의 안전한 참조와 복구용 identity를 사용한다. break-glass를 사용했다면 정상 자동화가 왜 실패했는지, 임시 접근이 남아 있지 않은지, runbook을 무엇을 고쳐야 하는지 사후 검토한다. 비상 접근은 자동화의 대체재가 아니라 자동화 실패를 안전하게 수습하는 마지막 경로다.

## 관찰 지표와 경보를 나누기

회전 작업에는 성공 신호와 실패 신호가 모두 필요하다. 성공 신호는 새 Secret revision을 참조하는 workload 수, 새 credential의 login 성공, 새 TLS certificate의 handshake, provider에서 새 key가 사용된 횟수처럼 실제 data plane의 관찰 값이다. 실패 신호는 controller sync 오류, secret mount 오류, authentication failure 급증, readiness 실패, 이전 credential 사용 지속, 만료 임박인데 회전 작업이 시작되지 않은 상태가 될 수 있다. Kubernetes event 하나만 보는 대신 application과 provider의 신호를 함께 묶어 본다.

경보는 담당자가 행동할 수 있게 만든다. "secret error"라는 알림보다 어떤 namespace·workload·revision에서 어떤 단계가 실패했고 마지막 정상 회전은 언제였는지, 어떤 runbook을 열어야 하는지를 알려 주는 편이 유용하다. 반대로 Secret value, token, customer data, 내부 endpoint를 alert message에 넣으면 관찰 도구가 새로운 유출 경로가 된다. 경보 채널의 접근 권한과 보존 기간도 비밀 관리 범위에 포함한다.

회전이 오래 걸리는 경우에는 진행 지표가 특히 중요하다. 여러 namespace를 순차 rollout할 때 일부 cluster만 새 값을 쓰는 상태가 길어지면, 옛 값을 아직 폐기할 수 없다. 완료 기준과 deadline을 둔 뒤 중간에 멈춘 대상은 재시도·rollback·수동 점검 중 무엇을 할지 정한다. 단순한 deployment success가 아니라 실제 connection 성공을 확인해야 한다.

## Secret 값과 구성 값을 분리하기

application configuration에는 database host, user name, TLS mode, timeout처럼 민감하지 않지만 동작에 중요한 값이 많다. 이 값을 Secret 안에 모두 넣으면 누가 읽어야 하는 범위가 넓어지고 변경 이력도 불명확해진다. 반대로 password를 ConfigMap에 넣으면 보호 경계가 사라진다. 민감도와 접근 필요성에 따라 Secret, ConfigMap, code default, external provider reference를 구분하고, workload가 어떤 조합으로 설정을 받는지 문서화한다.

이 분리는 회전 중 문제를 좁히는 데도 도움이 된다. 새 password에서만 login이 실패하는지, host 변경과 password 변경이 한 release에 섞였는지, TLS certificate chain 변경이 원인인지 구별할 수 있다. 한 번의 배포에서 여러 credential·endpoint·client library를 동시에 바꾸면 rollback 원인이 불명확해진다. 작은 독립 변경과 명시적인 revision 기록이 안전하다.

## 비용과 성능을 보안과 교환하지 않기

짧은 수명의 token과 잦은 reload는 provider 호출과 connection 재생성을 늘릴 수 있다. 그러나 이 비용을 줄이기 위해 무기한 credential을 쓰거나 token을 shared cache에 평문으로 두는 것은 다른 위험을 만든다. workload가 token을 얼마나 자주 새로 얻는지, provider rate limit이 어떤지, connection pool이 credential 변경 뒤 어떻게 동작하는지 측정 가능한 지표로 확인한다. 필요한 경우 token refresh를 분산하고 jitter를 주되, 만료 직전에 한꺼번에 실패하지 않도록 설계한다.

성능 문제가 보이면 먼저 권한 scope와 lifecycle을 유지한 채 refresh 방식, cache의 보호, rollout 순서를 조정할 수 있는지 본다. 보안 요구와 가용성 요구는 대립하는 문장이 아니라, 노출 시간과 실패 범위를 함께 관리하는 설계 조건이다.

## namespace 종료와 orphaned credential 정리

서비스를 폐기하거나 namespace를 삭제할 때 Secret object가 사라졌다고 외부 database 계정과 API key가 자동으로 폐기되는 것은 아니다. 반대로 namespace에 남아 있는 사용되지 않는 Secret은 누가 소유하는지 모른 채 오랜 기간 유지될 수 있다. service decommission checklist에는 Kubernetes object 삭제, 외부 credential 비활성화, secret manager reference 제거, CI variable 회수, audit 검토를 함께 넣는다. owner가 없는 credential은 정기 inventory에서 표시하고, 실제 사용 여부를 확인한 뒤 승인된 절차로 폐기한다.

orphaned credential을 찾을 때 단순히 최근 수정 시각만 보지 않는다. 오래된 batch가 월말에만 실행되거나 재해 복구 절차가 특정 key를 쓸 수 있다. workload reference, provider 사용 로그, 소유 팀 확인, 마지막 drill 기록을 함께 보고 판단한다. 삭제 전에는 되돌릴 수 있는 유예와 모니터링을 두되, 영구 예외가 되지 않도록 종료일과 책임자를 정한다.

## 공급망과 image build의 비밀 처리

container image를 build하는 동안 private package registry나 source repository credential이 필요할 수 있다. 이 값을 image layer, Dockerfile, build cache, artifact에 넣으면 runtime Secret 회전과 별개로 장기 노출이 생긴다. build system의 secret mount 또는 짧은 수명의 build identity를 사용하고, build log가 command argument와 환경 변수를 그대로 출력하지 않는지 확인한다. 완성된 image를 검사할 때도 config history와 layer에 credential 문자열이 없는지 점검한다.

runtime workload의 Secret과 build-time Secret은 발급자·보존 위치·회전 주기가 다를 수 있다. 둘을 같은 이름의 generic password로 관리하면 누가 사용하는지 혼동한다. inventory에 사용 단계와 owner를 기록하고, build가 끝난 뒤 더 이상 필요 없는 token은 폐기하거나 만료되게 한다. image가 이미 배포된 뒤 값을 바꿔도 layer 안의 과거 값은 사라지지 않으므로, 노출 사고에서는 image와 artifact의 범위도 조사해야 한다.

## 회전 절차의 문서화와 인수인계

Secret 회전 runbook에는 명령어만 나열하지 않는다. 회전 전 확인할 inventory, 새 credential 발급 책임자, 적용 대상 workload, canary 성공 기준, 관찰할 지표, 옛 값 폐기 승인자, 실패 시 중지 조건을 순서대로 적는다. 각 단계는 실제 값 대신 secret reference와 role 이름을 사용한다. 문서를 읽는 사람이 특정 담당자의 기억이나 개인 노트 없이도 필요한 시스템과 권한을 찾을 수 있어야 한다.

담당자가 바뀌거나 provider·배포 도구가 바뀌면 runbook도 갱신해야 한다. 오래된 명령어가 가장 위험한 순간은 비상 회전이다. 정기 drill에서 문서대로 수행한 시간, 헷갈린 단계, 권한 요청 대기, 실패한 health check를 기록하고 다음 회전에 반영한다. 문서의 목적은 모든 예외를 예측하는 것이 아니라, 위험한 순간에 추측과 값 공유를 줄이는 것이다.

## 회전 일정과 변경 창을 정하는 방법

회전 주기는 모든 credential에 같은 숫자를 적용하는 정책이 아니라, 값이 노출됐을 때의 영향·자동 발급 가능성·서비스의 재시작 비용·provider 제한·탐지 가능성을 함께 보는 결정이다. 사람 손으로 바꾸는 고위험 production password를 너무 짧은 주기로 강제하면 결국 예외가 쌓이거나 작업자가 값을 임시 파일에 저장하는 부작용이 생길 수 있다. 반대로 자동 발급과 workload identity가 가능한 token은 짧은 수명으로 운영해 노출 시간을 줄일 수 있다. 목표는 달력상의 회전 횟수가 아니라 유출된 값이 오래 유효하지 않고, 정상 회전이 서비스 품질을 해치지 않는 상태다.

변경 창도 비밀 유형별로 다르다. 사용자 트래픽이 높은 시간에 database credential을 한꺼번에 바꾸면 connection storm과 retry가 겹칠 수 있다. 반면 security incident에서 유출이 확인됐다면 정기 변경 창을 기다릴 수 없다. normal rotation과 emergency rotation의 승인·관찰·rollback 기준을 분리하고, emergency에서는 무엇을 포기하지 않는지 정한다. 예를 들어 회전 전 canary 검증은 짧게 할 수 있어도, 새 credential의 최소 권한과 audit는 생략하지 않는다.

## 복구와 backup에서 Secret을 보호하기

Kubernetes cluster backup에는 Secret 객체가 포함될 수 있고, application backup에는 database password나 API endpoint가 설정 파일로 들어갈 수 있다. 따라서 Secret 회전은 live cluster만이 아니라 backup의 노출 표면도 고려해야 한다. encryption at rest, backup 저장소의 접근 권한, 복구 환경의 network isolation, 오래된 snapshot의 보존 기간을 함께 점검한다. backup을 restore한 test cluster가 production 외부 provider에 연결되지 않도록 egress와 credential scope를 제한해야 한다.

유출 사고가 나면 새 값을 만든 뒤 과거 backup에서 옛 값이 발견될 수 있다. 이를 이유로 모든 backup을 즉시 지우면 재해 복구 능력을 잃을 수 있다. 대신 backup에 대한 접근을 좁히고, 옛 credential을 provider에서 무효화하며, restore drill에서는 새 또는 test credential으로 재구성하는 절차를 둔다. 복구 가능성과 비밀 노출을 하나의 선택으로 보지 말고, 보관·접근·무효화·격리라는 여러 통제를 결합한다.

## 도입을 시작할 때의 작은 체크리스트

처음부터 모든 Secret을 재설계하려 하기보다 가장 위험하고 소유자가 분명한 credential 하나를 고른다. 그 값이 어디에서 발급되고, 어떤 Pod와 job이 사용하며, 새 값을 동시에 활성화할 수 있는지, workload가 환경 변수인지 volume인지, 실제 성공을 어떤 metric으로 볼지를 적는다. test 환경에서 새 revision을 주입하고 application이 다시 연결하는지 확인한 뒤, canary와 점진 rollout을 연습한다. 이 작은 범위의 성공이 있어야 다른 비밀 유형에도 재사용 가능한 기준이 생긴다.

checklist에는 예외도 남긴다. 자동 회전할 수 없는 legacy provider, 동시에 두 key를 허용하지 않는 시스템, 사람 승인이 필요한 고위험 database는 왜 예외인지와 다음 검토 시점을 기록한다. 예외를 숨기면 값이 영구적으로 남고, 공개하면 개선 우선순위를 정할 수 있다. Secret 관리의 성숙도는 사용하는 도구 수보다, 어떤 값이 왜 남아 있고 누가 책임지는지 설명할 수 있는 정도에 가깝다.

## 정책과 자동화의 경계

정책 엔진은 privileged Pod가 특정 Secret을 mount하지 못하게 하거나, production namespace의 Secret 이름과 label 규칙을 강제하는 데 도움을 줄 수 있다. 그러나 policy가 Secret value의 유효성이나 application의 실제 reload를 증명하지는 않는다. admission 단계에서 막을 규칙, CI에서 검사할 manifest 규칙, runtime에서 관찰할 authentication 실패를 구분한다. policy를 추가한 뒤 정상 배포가 막히지 않는지, 긴급 회전 경로가 필요한 최소 권한으로 남아 있는지도 검증한다.

자동화는 반복 작업을 줄이지만 소유자를 없애지는 않는다. controller가 새 값을 동기화했어도 provider 권한이 너무 넓거나 application이 이전 값을 사용하면 회전은 끝나지 않는다. 자동화의 health, 마지막 성공 시각, 적용 대상, 실패 경보를 소유 팀이 볼 수 있어야 한다. 좋은 자동화는 사람이 값을 보지 않아도 상태와 실패 원인을 판단할 수 있게 만든다.

## 서비스 종료 뒤의 검증

옛 credential을 폐기한 뒤에도 provider access log와 application metric에서 계속 사용 시도가 없는지 본다. 일부 실패는 정상적인 cache 만료 지연일 수 있지만, 반복되는 시도는 빠뜨린 workload나 공격자의 사용일 수 있다. 정해진 관찰 기간이 끝나면 inventory를 갱신하고, 회전 작업의 증거와 남은 예외를 소유 팀에 전달한다. 값이 삭제됐다는 사실만으로 작업을 닫지 않고 실제 호출이 멈췄는지 확인해야 한다.

## 회전 품질을 확인하는 사후 검토

정기 회전이 끝난 뒤에는 단순히 ticket을 닫지 말고, 새 값 발급부터 폐기까지 각 단계의 시간을 짧게 돌아본다. 준비한 inventory가 정확했는지, canary가 실제 문제를 잡을 수 있었는지, 어떤 workload가 늦게 반영됐는지, 경보가 행동 가능한 정보를 줬는지, 옛 값이 예상 시각에 폐기됐는지를 확인한다. 문제가 없었다면 그것도 runbook이 현재 환경과 맞는다는 증거가 된다. 문제가 있었다면 다음 회전 전에 고칠 항목과 소유자를 남긴다.

특히 재시작 때문에 생긴 connection spike, provider rate limit, 누락된 CronJob, 오래된 개발 환경 key처럼 반복되기 쉬운 문제는 개인의 실수로만 기록하지 않는다. 공통 manifest, controller 설정, inventory 자동 수집, 배포 순서, 권한 template 가운데 어떤 시스템적 개선이 가능한지 찾는다. 회전은 비밀 하나를 교체하는 작업이지만, 이 검토를 통해 서비스의 identity 경계와 운영 절차를 계속 단단하게 만들 수 있다.

## 최소한의 검증 자동화

회전 절차가 안정되면 CI나 scheduled job으로 값 자체를 노출하지 않는 검증을 추가할 수 있다. 예를 들어 manifest가 존재하지 않는 Secret을 참조하지 않는지, production workload가 금지된 static key를 환경 변수에 직접 받지 않는지, 만료 예정 항목에 owner와 다음 회전일이 있는지 검사한다. 이런 검사는 외부 provider에 실제 변경을 만들지 않는 read-only 점검부터 시작하는 편이 안전하다.

자동 검사는 사람의 판단을 없애지 않는다. 새 credential의 권한이 과도한지, 유예 기간이 업무상 적절한지, incident 중 rollback을 허용할지 같은 결정은 맥락이 필요하다. 그러나 반복되는 누락을 빠르게 보이면 사람이 중요한 위험과 검증에 더 집중할 수 있다.

작은 검사라도 배포 경계 가까이에서 반복되면, 회전 전날 급하게 목록을 맞추는 작업보다 신뢰할 수 있는 예방 장치가 된다.

검사 결과와 예외 사유를 함께 남기면 다음 담당자도 동일한 기준으로 판단할 수 있다.

## 한계와 적용 기준 Q&A

### Q. Secret을 etcd encryption으로 저장하면 별도 secret manager가 필요 없나요?

A. etcd encryption은 저장된 값을 보호하는 중요한 계층이지만, 누가 Kubernetes API로 값을 읽을 수 있는지, backup과 audit은 어떻게 관리하는지, 외부 provider credential의 만료는 어떻게 처리하는지까지 해결하지는 않습니다. 조직의 권한 모델과 외부 시스템 조건에 맞춰 추가 저장소나 identity 방식을 판단해야 합니다.

### Q. 모든 Secret을 환경 변수 대신 volume으로 바꾸면 재시작이 필요 없나요?

A. 아닙니다. volume 파일이 갱신되어도 application이 다시 읽지 않을 수 있고, 기존 connection pool은 이전 credential을 유지할 수 있습니다. 실제 client의 reload 방식과 새 연결 생성 여부를 확인해야 합니다.

### Q. 회전 중 오류가 나면 무조건 옛 값으로 되돌려야 하나요?

A. credential 유출이 의심되는 회전이라면 옛 값을 다시 쓰는 것이 보안 위험을 연장할 수 있습니다. 오류 원인, 서비스 영향, 유출 가능성에 따라 새 credential 수정·권한 보정·부분 중지·대체 identity를 선택해야 하며, 사전에 보안과 운영 책임자의 판단 기준을 정해 두는 편이 좋습니다.

## 마무리

Kubernetes Secret 회전은 YAML의 data를 바꾸는 작업이 아니라, 외부 credential 발급부터 workload 반영·실제 연결 검증·옛 값 폐기·감사까지 잇는 운영 절차다. Secret 객체와 실행 중인 process의 상태를 분리해 보고, 비밀 유형과 반영 방식에 맞춘 rollout·rollback·권한 모델을 설계하면 회전은 정기 장애가 아니라 노출 시간을 줄이는 통제가 된다.

<h3 class="references-heading">참고 자료</h3>

- [Kubernetes: Secrets](https://kubernetes.io/docs/concepts/configuration/secret/)
- [Kubernetes: Good practices for Kubernetes Secrets](https://kubernetes.io/docs/concepts/security/secrets-good-practices/)
- [Kubernetes: Encrypting Confidential Data at Rest](https://kubernetes.io/docs/tasks/administer-cluster/encrypt-data/)
- [Kubernetes: Configure Service Accounts for Pods](https://kubernetes.io/docs/tasks/configure-pod-container/configure-service-account/)
