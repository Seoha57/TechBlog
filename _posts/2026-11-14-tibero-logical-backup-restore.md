---
layout: post
title: "Tibero 논리 백업과 복구를 설계하는 법: Export·Import·검증·복구 범위"
categories: [DBA]
tags: [tibero, dba, backup, restore, export, import, recovery]
description: "Tibero에서 논리 백업과 복구를 이해하기 위해 객체·데이터·권한의 범위를 나누고, export/import 전후 검증과 운영 기준을 설명합니다."
---

## 먼저 답하기

### Q. export 파일만 있으면 Tibero 데이터베이스를 언제든 복구할 수 있나요?

A. export는 schema 객체와 데이터를 논리적인 형태로 옮기는 유용한 수단이지만, 모든 복구 문제를 해결하지는 않는다. 파일이 어느 시점의 데이터인지, 어떤 사용자·schema·권한·객체를 포함하는지, 대상 database version과 charset이 호환되는지, 물리 파일 손상이나 point-in-time 복구가 필요한 상황인지에 따라 결과가 달라진다. 백업 파일의 존재보다 실제로 격리 환경에 import해 검증할 수 있는지가 중요하다.

### Q. 운영 database에 바로 import하면 되나요?

A. 권장하지 않는다. import는 table·index·constraint·권한·데이터를 바꾸거나 기존 객체와 충돌할 수 있다. 먼저 별도 복구 환경 또는 명확히 분리된 schema에서 실행하고, 필요한 데이터·객체·권한이 맞는지 검증한 뒤 production 반영 방법을 결정해야 한다. 전체를 덮어쓸지, 필요한 객체 또는 row만 비교·보정할지는 사고 범위와 이후 정상 변경을 기준으로 판단한다.

## 먼저 알아둘 기반 기술

### 논리 백업과 물리 백업

논리 백업(logical backup)은 table definition, index, constraint, user, data 같은 database 객체를 재생성 가능한 논리 단위로 내보내는 방식이다. 특정 schema를 다른 환경으로 옮기거나, 일부 table을 복구하거나, 객체 정의를 검토하는 데 적합할 수 있다. 물리 백업(physical backup)은 data file, control file, archive log 같은 저장 구조와 복구 절차를 중심으로 database를 특정 시점에 되살리는 방식이다. 두 방식은 경쟁하지 않으며 RPO(Recovery Point Objective), RTO(Recovery Time Objective), 데이터 크기, 복구 범위에 따라 함께 설계한다.

### schema, user, privilege의 관계

schema는 database 객체가 속한 논리적 이름 공간이고, user는 database에 연결하고 권한을 받는 주체다. table data만 import해도 synonym, sequence, view, stored procedure, trigger, role, object privilege, directory 같은 의존 객체가 빠지면 application은 정상 동작하지 않을 수 있다. 반대로 모든 권한을 무심코 옮기면 대상 환경에서 과도한 권한을 만들 수 있다. backup 범위를 "데이터"가 아니라 객체·권한·의존성의 묶음으로 봐야 한다.

### 일관성 있는 시점

백업 중에도 transaction이 계속 진행되면 서로 관련된 table이 다른 시점의 값을 가질 수 있다. 주문 row는 backup됐지만 결제 row는 아직 반영되지 않았거나, schema 변경이 중간에 적용되는 경우가 예다. 사용 중인 export 도구와 옵션이 어떤 일관성 보장을 제공하는지, 장시간 작업 중 DDL이 어떻게 되는지, backup 시작·종료 시각과 대상 database 상태를 runbook에 기록한다. 특정 옵션의 정확한 의미는 설치된 Tibero version의 공식 문서를 확인해야 한다.

## 논리 백업이 필요한 상황과 한계

논리 백업은 개발·검증 환경에 representative schema를 만들거나, 특정 schema의 객체 정의를 보관하거나, 실수로 삭제한 작은 범위의 데이터를 격리 환경에서 찾아 보정할 때 유용하다. version upgrade 전 compatibility 검토, tenant 단위 export, 감사용 객체 비교에도 쓸 수 있다. 사람이 읽고 비교할 수 있는 형태 또는 tool이 해석하는 dump라는 성질 때문에 선택적 복구와 검증에 장점이 있다.

하지만 대용량 database를 빠르게 전체 복구해야 하거나 storage 손상·instance 장애가 난 경우에는 논리 export만으로 RTO를 맞추기 어려울 수 있다. export 작업 자체가 오래 걸리고 import 뒤 index 재생성·통계 수집·권한 설정·application 검증이 필요할 수 있다. 논리 backup을 물리 backup, archive log, HA 구성의 대체물로 설명해서는 안 된다. 각각이 어떤 실패 유형을 다루는지 복구 전략에 명시한다.

## 백업 범위를 먼저 결정하기

운영자는 "전체 export"를 기본값으로 생각하기 쉽지만, 복구 목적에 따라 범위를 나누는 편이 안전하다. 전체 database export는 넓은 복구 재료를 제공하지만 파일 크기·실행 시간·민감 데이터 노출 범위가 커진다. schema export는 서비스 단위 복구와 환경 이동에 맞을 수 있고, table export는 특정 reference data 또는 손상된 객체를 조사할 때 유용하다. 범위를 줄일수록 빠르고 읽기 쉬워지지만 빠진 의존성을 따로 관리해야 한다.

각 backup job에는 대상 database 식별자, schema 목록, 제외한 대형·민감 table, 시작·종료 시각, 도구 version, 옵션, checksum, 저장 위치, 보존 만료일을 metadata로 남긴다. file name만 보고 복구 대상을 추측하면 같은 이름의 test·production 파일을 섞을 수 있다. metadata에는 password나 connection string을 넣지 않는다. 복구 시 필요한 credential은 별도 secret 관리 경로에서 얻어야 한다.

## Export 전 점검

backup을 실행하기 전에 database 연결 가능 여부, 저장 공간, 대상 schema의 크기와 객체 수, 장시간 실행 중 영향, backup 계정의 최소 권한을 확인한다. export 계정이 필요한 객체를 읽을 수 있어야 하지만 모든 관리 권한을 가질 필요는 없다. job output과 error log가 어느 위치에 남는지, dump file이 암호화된 storage로 이동하는지, 실패했을 때 부분 파일을 성공으로 오해하지 않는지도 점검한다.

DDL 변경과 대규모 batch가 예정된 시간에는 backup 일관성과 성능이 영향을 받을 수 있다. 무조건 서비스가 한가한 시간을 찾기보다, 복구 목표·업무 마감·storage backup window·replication과의 관계를 함께 고려한다. backup window 동안 schema migration을 막거나, 변경 이력을 기록하고 restore test에서 같은 조건을 확인하는 운영 규칙이 필요할 수 있다.

## 업무 예시: 잘못 삭제한 기준 데이터 복구

상품 분류 같은 기준 table의 일부 row가 잘못 삭제됐다고 가정해 보자. 전체 production database를 어제 상태로 되돌리면 이후 정상 주문·재고 변경까지 잃을 수 있다. 먼저 삭제 범위와 시각, 영향을 받는 table·foreign key·application cache·외부 시스템을 확인한다. 다음으로 격리된 복구 database 또는 별도 schema에 적절한 논리 backup을 import하고, 삭제 전 row와 현재 production row를 비교한다.

복구 환경에서 필요한 row와 관련 sequence·reference table을 확인한 뒤, production에 적용할 보정 SQL을 작게 만든다. 이 SQL은 peer review와 transaction·rollback 계획을 거쳐야 하며, 기존에 새로 생성된 row와 primary key 충돌하지 않는지 확인한다. 적용 후에는 row count뿐 아니라 화면 조회·batch 처리·참조 무결성을 점검한다. 이 예시는 직접 운영 경험이 아니라 논리 backup이 전체 복구보다 선택적 보정에 적합할 수 있음을 설명하기 위한 시나리오다.

## Import 전 격리와 충돌 방지

import는 대상 환경을 바꿀 수 있으므로 먼저 연결 문자열과 database identity를 눈으로 확인한다. production database를 향하는 shell alias나 환경 변수가 남아 있으면 복구 연습이 실제 장애로 변할 수 있다. 격리된 instance, 다른 service name, 제한된 network, 전용 복구 계정을 사용하고, 외부 batch·scheduler·application이 import 대상 schema에 쓰지 못하게 한다.

기존 객체와 이름이 충돌할 때 drop하고 다시 만들지, 다른 schema로 mapping할지, 이미 있는 table의 data를 어떻게 다룰지 사전에 정한다. 무심코 `DROP`을 포함하는 옵션을 production에 쓰면 되돌릴 수 없는 손상을 만들 수 있다. restore runbook에는 대상 환경 확인, dry-run 또는 목록 확인, 필요한 객체 범위, 중지 조건, rollback 또는 cleanup 절차를 넣는다.

## 복구 뒤 검증

기술 검증은 import process가 성공했다는 메시지보다 넓다. 대상 schema와 table·view·sequence·index·constraint·trigger가 예상 개수로 존재하는지, invalid object가 없는지, row count와 key range가 backup metadata 또는 기준 query와 맞는지 확인한다. 대용량 table의 전체 비교가 부담되면 중요 key 범위·집계·sample query로 범위를 좁히되, sample만으로 완전한 복구를 주장하지 않는다.

업무 검증은 application 관점에서 대표 흐름을 확인하는 단계다. 기준 데이터라면 화면에서 올바른 이름이 보이는지, 주문·정산 batch가 참조 오류 없이 동작하는지, 권한 있는 사용자만 변경할 수 있는지를 확인한다. import가 권한이나 synonym을 누락하면 data는 있어도 application connection이 실패할 수 있다. DBA, application owner, 업무 담당자가 각자 확인할 기준을 나누면 "database는 정상"과 "서비스는 정상"을 혼동하지 않는다.

## 보존, 암호화, 접근 제어

논리 dump에는 고객 데이터와 schema 정보가 포함될 수 있으므로 production data와 비슷한 민감도로 취급한다. 암호화된 저장소, 최소 권한 access role, 접근 audit, 전송 중 암호화, 보존 기간, 삭제 정책을 정한다. 개발자가 테스트를 위해 dump를 내려받아 개인 PC에 오래 보관하면 central backup의 통제가 무너진다. 필요한 경우 masking된 test dataset을 별도로 만들고, production dump의 사용은 승인된 복구 환경으로 제한한다.

보존 기간은 저장 비용만이 아니라 사고 발견 지연과 감사 요구를 반영한다. 너무 빨리 삭제하면 오래된 논리 오류를 조사할 재료가 없고, 무기한 보관하면 유출 면적이 늘어난다. lifecycle policy가 실제로 파일을 삭제하는지, 삭제 전 필요한 metadata와 checksum이 남는지, backup을 restore할 권한이 누구에게 있는지 정기적으로 점검한다.

## 정기 복구 연습

export job의 성공은 restore 성공 증거가 아니다. 정기적으로 격리 환경에 파일을 가져와 import하고, 객체·데이터·권한·대표 업무 흐름을 확인한다. 이 drill에서 file download, decrypt, import, index·통계 처리, 검증, cleanup까지 걸린 시간을 기록하면 RTO 가정이 현실적인지 알 수 있다. 직접 성능을 측정하지 않았다면 목표 시간과 연습 결과를 섞어 쓰지 말고 계획과 관찰 사실을 구분한다.

연습이 끝나면 임시 database와 dump copy, 로그의 민감 정보, 복구 계정을 정리한다. 실패한 단계와 수정한 runbook을 남기면 다음 담당자도 같은 순서로 재현할 수 있다. 작은 schema부터 시작해 범위를 넓히는 방식이, 문서만 길고 실제로 import해 보지 못하는 계획보다 낫다.

## 객체 의존성을 목록으로 관리하기

논리 백업에서 가장 자주 생기는 오해는 table만 있으면 서비스가 살아난다는 생각이다. 실제 application은 sequence로 번호를 만들고, view와 synonym으로 객체를 찾고, trigger와 stored procedure로 규칙을 수행하며, role과 object privilege로 연결을 허용한다. partition, LOB, scheduler job, directory, database link처럼 schema 밖 또는 다른 사용자와 연결된 객체도 있을 수 있다. export 범위를 정할 때 중요한 업무 flow가 어떤 객체를 참조하는지 dependency 목록을 만든다.

이 목록은 모든 system catalog를 외워서 만드는 문서가 아니다. 대표 application query, batch, migration, 장애 이력에서 중요한 객체부터 시작한다. 복구 test에서 누락된 synonym이나 privilege가 발견되면 목록과 runbook을 보완한다. 객체 수가 많을수록 export 성공률보다 import 뒤 invalid object와 dependency 오류를 분류하는 과정이 중요하다.

## 성능 영향과 backup window

논리 export는 database CPU, I/O, undo 또는 temporary resource, network와 backup storage를 사용할 수 있다. production workload가 높은 시간에 큰 export를 수행하면 서비스 latency와 backup 시간이 함께 늘 수 있다. 반대로 너무 좁은 야간 window에 무리하게 끝내려 하면 실패한 파일을 검증하거나 재시도할 여유가 없다. 대상 schema 크기, 변화량, job concurrency, storage throughput을 관찰하고 운영 시간과 복구 목표에 맞는 일정을 정한다.

성능을 이유로 검증을 빼면 backup은 빨라 보여도 복구가 불가능할 수 있다. checksum, 파일 크기 이상 탐지, metadata 작성, 주기적인 import drill은 별도의 job으로 분리할 수 있지만 생략해서는 안 된다. 직접 측정한 수치가 없으면 특정 시간이 충분하다고 단정하지 말고, 실제 drill 결과로 window와 RTO를 조정한다.

## 오류 처리와 재시도 기준

backup job이 중간에 실패했을 때 부분 dump를 정상 파일처럼 보관하면 이후 복구가 더 위험해진다. job은 성공 marker와 checksum이 만들어진 경우에만 publish하고, 실패 파일은 원인을 분석할 수 있게 격리하되 복구 대상 목록에는 넣지 않는다. storage upload와 export 생성이 별도 단계라면 둘 다 성공했는지 확인한다. 재시도는 source database 부하와 disk 공간을 고려해 제한하고, 반복 실패는 담당자에게 원인과 마지막 성공 backup 시각을 알려야 한다.

import도 같은 원칙이다. 객체 생성 오류를 무시한 채 data를 계속 넣으면 부분적으로만 복구된 schema가 남을 수 있다. 오류를 허용할 수 있는 객체와 즉시 중지해야 하는 객체를 구분하고, 실패한 import 환경은 다음 시도 전에 삭제하거나 명확한 새 schema로 분리한다. 이전 실패의 찌꺼기가 다음 성공을 가장하는 일을 막아야 한다.

## 변경 관리와 version 호환성

source와 target Tibero version, patch level, character set, NLS 설정, feature 사용 여부가 다르면 export 파일의 객체가 같은 의미로 import되지 않을 수 있다. upgrade 또는 migration 전에는 작은 representative schema로 export/import test를 하고, unsupported object와 behavior 차이를 확인한다. 운영 복구에서는 version을 임의로 바꾸지 않고, backup을 만든 환경과 복구 환경의 차이를 metadata와 runbook에 기록한다.

schema migration과 backup의 순서도 연결한다. migration 직전 backup이 필요한지, migration 실패 시 논리 import가 어떤 범위를 되돌리는지, 새 application code가 이전 schema를 읽을 수 있는지 검토한다. destructive DDL은 data만 복원해도 application 의미가 달라질 수 있으므로 migration owner와 DBA가 복구 시나리오를 함께 검토한다.

## 사용자와 권한을 옮길 때의 주의점

논리 backup에는 객체 definition과 data가 들어가더라도 대상 환경의 user·role·system privilege가 source와 동일해야 하는 것은 아니다. 개발·검증 환경에 production 권한을 그대로 복사하면 불필요한 관리 권한과 외부 연결 권한을 줄 수 있다. user 생성, quota, default tablespace, object privilege, role 부여를 복구 범위에서 분리해 검토하고, 대상 환경의 보안 정책에 맞는 최소 권한으로 재구성한다.

application이 특정 schema가 아니라 synonym이나 public object를 통해 table에 접근하는 경우에도 import 뒤 연결 오류가 날 수 있다. 권한 오류를 해결하려고 광범위한 privilege를 즉시 부여하기보다, 실제 connection user와 필요한 object·operation을 확인한다. 복구 환경에서는 application service account와 DBA 계정을 구분해, data 검증과 관리 작업의 audit trail이 섞이지 않게 한다.

## 대용량 객체와 LOB 데이터

대용량 table이나 LOB(Large Object) column은 export file 크기와 import 시간에 큰 영향을 줄 수 있다. 모든 data를 한 번에 옮길 수 있는지, 특정 기간·partition만 필요한지, archive data가 서비스 복구에 필요한지 판단한다. 파일이 크다는 이유만으로 LOB를 무조건 제외하면 application이 첨부 문서나 이미지 metadata를 읽지 못할 수 있다. 반대로 복구 목적과 무관한 오래된 data를 포함하면 storage·전송·보안 부담이 늘어난다.

대용량 backup은 checksum과 파일 목록을 특히 중요하게 관리한다. 하나의 손상된 조각이 import 중간에 발견되면 긴 작업을 다시 시작해야 할 수 있다. 저장소 전송 완료, 암호화·압축 처리, 다운로드 가능 여부를 별도 단계로 확인하고, 복구 drill에서는 실제로 가장 큰 객체가 포함된 sample을 선택한다. 작은 schema만 성공한 결과로 전체 database의 RTO를 추정해서는 안 된다.

## 통계와 실행 계획의 복구 뒤 작업

data와 index가 복원돼도 optimizer statistics가 source와 같지 않거나, 대상 환경의 data distribution·parameter가 달라 application query 성능이 달라질 수 있다. 논리 import 뒤 어떤 통계를 수집할지, 대량 작업으로 system 부하가 높아지지 않게 언제 수행할지 운영 계획에 넣는다. restore 성공을 성능 정상으로 과장하지 않고, 핵심 query의 응답 시간·실행 계획·오류를 관찰할 기준을 둔다.

통계 작업을 무조건 즉시 전체 수행하는 것도 정답은 아니다. 복구 범위가 작은 table이라면 필요한 객체에 집중할 수 있고, 전체 서비스 복구가 우선이라면 query workload와 maintenance window를 고려해야 한다. 중요한 것은 import 후 성능이 나쁠 때 data 손상으로만 판단하지 않고, 통계·권한·resource·application connection을 분리해 진단하는 것이다.

## 백업 보관소의 무결성 확인

backup 서버 또는 object storage는 database와 다른 장애 도메인에 있어야 한다. 같은 host의 같은 disk에 export를 두면 host·filesystem 장애와 함께 사라질 수 있다. 원격 저장소로 복사할 때 전송 성공 코드만 보지 말고 file size, checksum, metadata, encryption 상태를 확인한다. 저장소 접근 권한을 가진 계정이 실수로 모든 backup을 삭제하지 못하도록 versioning·retention·삭제 승인 같은 통제를 검토할 수 있다.

backup 파일을 암호화해도 key가 없으면 restore할 수 없고, key를 파일과 같은 곳에 같은 권한으로 두면 보호 효과가 약하다. key management와 break-glass access, key rotation 뒤 오래된 file의 복호화 가능 여부를 복구 drill에서 확인한다. 실제 key나 password를 runbook·shell history·ticket에 넣지 않는 원칙은 export/import 작업에도 그대로 적용된다.

## 장애 대응의 의사결정

논리 오류가 생겼을 때 즉시 import를 시작하는 것보다 먼저 추가 변경을 어떻게 관리할지 판단해야 한다. 현재 production의 쓰기를 계속 허용하면 이후 정상 data가 늘어나 전체 restore는 더 어려워질 수 있다. 반대로 모든 서비스를 멈추면 고객 영향이 커진다. 영향받은 batch만 중지할지, 특정 기능을 read-only로 만들지, 전체 maintenance를 할지는 사고 범위·복구 재료·업무 중요도에 따라 incident 책임자가 결정한다.

격리 환경에서 복구한 data를 production에 반영하기 전에는 source와 current data의 차이, foreign key·sequence 충돌, 외부 시스템 상태, rollback 가능성을 검토한다. DBA가 기술적 범위를 설명하고 application owner가 업무 의미를 확인하며, security 담당자가 데이터 노출과 접근 절차를 확인하면 한 사람의 추측을 줄일 수 있다. 사고 기록에는 실제 data 값 대신 영향 범위·시각·결정·검증 결과를 남긴다.

## 복구 환경의 네트워크와 외부 부작용 차단

복구 환경에 production export를 import한 뒤 application을 실수로 연결하면 email, payment, partner webhook, scheduler가 과거 data를 기준으로 실제 작업을 실행할 수 있다. restore network에서는 외부 egress를 제한하고, DNS·endpoint·credential을 test 대상으로 바꾸거나 application을 read-only 검증 모드로 둔다. database connection이 가능하다는 사실만으로 background job이 안전하다고 가정해서는 안 된다.

복구 환경의 user와 service account도 production과 분리한다. test query를 수행하는 사람에게 외부 provider 권한이 필요하지 않으며, dump를 조사하는 도구가 운영 database에 다시 쓰기하지 못하게 한다. drill을 마친 뒤 instance·storage·임시 credential을 폐기하거나 접근을 회수하는 cleanup까지 runbook에 넣는다.

## 운영 자동화와 사람 검토의 역할

backup 생성, checksum, 원격 upload, 보존 만료 점검은 scheduled job으로 자동화할 수 있다. 자동화 결과에는 대상 schema, file identifier, 시작·종료 시각, 크기, checksum, 성공·실패 단계가 남아야 한다. 그러나 자동 job이 성공했다고 업무 복구가 보장되는 것은 아니다. 새로운 schema dependency, application 변경, key access, 복구 우선순위는 사람이 검토해야 한다.

자동화가 실패했을 때는 재시도 횟수와 중지 기준을 정한다. disk가 가득 찼거나 대상 database가 부하가 높은데 무한 재시도하면 서비스에 더 영향을 줄 수 있다. 마지막 검증된 backup 시각과 실패 원인, 담당자와 runbook 링크를 경보로 보내면 사람은 파일을 찾는 대신 판단을 시작할 수 있다.

## table 단위 복구와 전체 schema 복구의 선택

특정 table의 data만 잘못됐다고 해도 table export/import가 항상 가장 안전한 것은 아니다. 그 table을 참조하는 foreign key, trigger, sequence, materialized object, application cache, batch가 함께 영향을 받을 수 있다. table 단위 복구를 선택할 때는 현재 production data와 복구본을 비교해 어떤 row를 넣거나 갱신할지 결정하고, 기존 row를 무심코 truncate하거나 overwrite하지 않도록 한다. 전체 schema 복구는 범위가 넓어 더 많은 의존성을 되살릴 수 있지만 이후 정상 변경과 충돌할 위험도 크다.

선택 기준은 파일 크기보다 data 의미다. 기준 데이터처럼 변경이 적고 외부 side effect가 작은 객체는 격리 환경에서 비교해 선택적으로 보정할 수 있다. 주문·권한·정산처럼 시간 순서와 여러 system의 상태가 얽힌 데이터는 database만 과거로 돌려도 업무 상태가 맞지 않을 수 있다. 이런 경우에는 복구 전에 application owner와 업무 담당자가 어떤 상태를 정답으로 볼지 합의해야 한다.

## 검증 query와 증거 남기기

복구 검증에는 무거운 전체 table scan만 필요한 것은 아니다. 객체 수, table별 row count, primary key 범위, null 비율, 중요한 code 값의 분포, 참조 관계가 깨진 row 수처럼 목적에 맞는 query를 만든다. query는 대상 환경과 시점을 명시하고, 실행 자체가 production 부하를 크게 만들지 않는지 고려한다. sample은 빠르지만 누락을 증명하지 못하므로, 무엇을 sample으로만 확인했는지 기록한다.

검증 결과에는 backup identifier, export 시작·종료 시각, import 환경, 도구·database version, checksum, 수행자 역할, 확인 query, 발견한 차이, 최종 결정과 승인자를 남긴다. 이 기록에는 고객 원문 data와 password를 넣지 않는다. 다음 drill에서 같은 기준으로 비교할 수 있고, 사고 중에 이미 확인한 사실을 반복 조사하지 않아도 된다.

## 운영 문서의 최소 구성

복구 runbook은 product 이름과 긴 명령어만 적는 문서가 아니다. 어떤 장애가 논리 export 복구 대상인지, 최신 verified backup은 어디에 있는지, 격리 환경은 어떻게 얻는지, 누가 접근을 승인하는지, import 전에 무엇을 멈추는지, 기술·업무 검증을 누가 하는지, cleanup은 어떻게 하는지를 포함한다. 실제 명령은 현재 Tibero version과 설치 경로에 맞춰 유지하고, placeholder를 복사해 production을 가리키지 않도록 주의 문구를 둔다.

문서가 최신인지 확인하는 가장 좋은 방법은 정기적으로 다른 담당자가 drill을 해 보는 것이다. 사람이 바뀌어도 credential 요청, 파일 다운로드, import, 검증, 정리를 수행할 수 있어야 한다. 문서에서 막히는 단계는 개인의 숙련도 문제가 아니라 복구 절차의 개선 항목으로 본다.

## 백업 파일의 naming과 manifest

백업 파일 이름에는 생성 날짜만 넣기보다 환경, database 또는 service 식별자, schema 범위, 도구 version, 논리 backup 유형을 알 수 있는 안전한 metadata를 포함한다. 단, customer 이름, host address, password, access token처럼 민감한 정보는 file name에 넣지 않는다. 별도의 manifest에는 checksum, 생성 시각, source version, 포함·제외 범위, 보관 위치, encryption key reference, 검증 상태를 기록한다. 파일과 manifest가 함께 이동하고 보존되어야 복구 시점에 추측을 줄일 수 있다.

manifest는 사람이 만든 메모에만 의존하지 않도록 backup job이 가능한 metadata를 자동으로 남기고, 사람은 복구 목적과 예외를 보완하는 방식이 좋다. restore drill에서 manifest만 보고 올바른 file을 골라 import할 수 있는지 확인하면 이름 규칙의 가치를 검증할 수 있다. 같은 날 여러 번 만든 test·production backup을 혼동하는 실수도 줄어든다.

## 감사와 규정 준수의 관점

어떤 data를 누가 export하고 누가 import했는지, 어느 저장소에서 얼마나 오래 보관하는지는 기술 운영뿐 아니라 감사 요구와 연결될 수 있다. 모든 작업자를 불신하자는 뜻이 아니라, 필요한 책임과 재현성을 갖추자는 뜻이다. backup 접근은 최소 권한 role로 제한하고, 내려받기·복호화·복구 작업에 audit event를 남기며, export file을 개인 device나 승인되지 않은 collaboration 도구로 옮기지 않는 원칙을 둔다.

규정이나 계약이 요구하는 보존 기간이 있어도 모든 사람이 원문을 읽을 수 있어야 하는 것은 아니다. 암호화, access review, 분리된 복구 환경, masked test dataset을 조합해 보관과 사용을 구분한다. 정책이 바뀌면 lifecycle rule, backup job, manifest, drill 환경이 실제로 바뀌었는지 다시 확인한다.

## 복구 우선순위와 업무 연속성

모든 schema를 같은 순서와 속도로 복구할 필요는 없다. 고객 로그인과 핵심 조회에 필요한 reference data, 주문·정산처럼 시간 민감한 업무 data, 내부 분석용 history는 복구 우선순위가 다를 수 있다. business owner와 함께 최소 서비스 제공에 필요한 객체와 나중에 복구해도 되는 객체를 정하면, 제한된 시간과 storage·인력으로 더 중요한 업무를 먼저 되살릴 수 있다. 이 우선순위는 disaster가 난 뒤 즉흥적으로 정하지 말고 정기 review한다.

업무 연속성은 database가 열리는 순간 끝나지 않는다. application configuration, connection pool, batch schedule, 외부 interface, 고객 화면, 운영 도구가 복구된 schema와 맞는지 확인해야 한다. 부분 복구를 선택했다면 어떤 기능이 아직 제한되는지 support와 사용자에게 정확히 알릴 경로도 필요하다. 기술적 복구와 업무 공지를 함께 계획해야 혼란을 줄일 수 있다.

## test data와 production data의 분리

복구 연습에는 production dump를 그대로 쓰고 싶을 수 있지만, 개인정보와 계약 정보가 포함될 수 있다. 가능하면 schema와 분포를 보존한 masked dataset 또는 synthetic dataset으로 기본 drill을 수행하고, production backup이 꼭 필요한 검증은 승인된 격리 환경에서 제한된 담당자가 한다. test data가 너무 단순하면 dependency와 대용량 객체 문제를 놓칠 수 있으므로, 필요한 특성을 정의해 mask 방식과 sample 범위를 검토한다.

개발 환경에서 dump를 재사용할 때는 보존 기간과 삭제 절차를 정한다. 오래된 export가 build artifact, shared folder, 개인 PC에 남아 있으면 중앙 저장소의 encryption과 access review를 우회한다. backup 전략은 파일을 만드는 기술뿐 아니라 파일이 복사되고 폐기되는 전체 lifecycle을 관리하는 일이다.

## 복구 절차의 책임 분담

복구는 DBA 혼자 수행하는 명령 실행이 아니다. DBA는 backup 파일·database 상태·객체 의존성·import 결과를 확인하고, infrastructure 담당자는 격리된 compute·storage·network와 접근 경로를 준비하며, application owner는 설정·migration·대표 기능을 검증한다. 업무 담당자는 어떤 data와 흐름이 우선인지 판단하고, security 담당자는 민감 data 접근과 audit를 확인한다. 역할을 사전에 나누면 incident에서 누가 다음 결정을 해야 하는지 기다리는 시간을 줄일 수 있다.

각 역할의 인수인계 기준도 적는다. 예를 들어 DBA가 import 성공과 invalid object 목록을 전달하면 application owner는 로그인·주문·batch 같은 업무 검증을 수행하고, security 담당자는 임시 credential과 dump copy의 회수를 확인한다. 모든 사람이 모든 권한을 갖는 방식보다 필요한 단계에서 필요한 증거를 넘기는 방식이 안전하다.

## 장기적인 개선 기준

restore drill에서 반복적으로 download가 느리거나 import 시간이 RTO를 넘거나 특정 객체가 누락된다면, 더 큰 물리 backup, archive log 기반 복구, storage 구조 변경, schema 분할, data lifecycle 조정 같은 투자를 검토할 근거가 된다. 논리 export를 억지로 모든 요구에 맞추기보다 현재 방식의 한계를 측정 가능한 기록으로 남기고, 업무 요구와 비용을 비교해 다음 단계를 선택한다.

가장 좋은 backup 전략은 한 도구를 고집하는 것이 아니라, 장애 유형과 복구 목표에 맞는 여러 계층을 조합하고 실제로 복구 가능한지 반복해서 증명하는 전략이다. 논리 backup은 그중 선택적 검증과 객체 수준 복구에 강점을 가진 한 축으로 다루면 된다.

## 정상 상태로 돌아간 뒤의 정리

복구가 끝난 뒤에는 임시 schema, dump 복사본, test account, network 예외, 수동으로 만든 monitoring override를 정리한다. 이 cleanup을 빼면 다음 drill의 결과가 오염되고 민감 data가 필요 이상으로 남는다. 복구 중 변경한 configuration과 scheduler도 원래 정책으로 돌아갔는지 확인한다.

사후 검토에서는 사고·drill의 원인, 복구 범위, 걸린 단계, 누락된 dependency, 문서 수정, 다음 검증 일정을 간단히 남긴다. 결과를 바탕으로 backup 자체뿐 아니라 migration·권한·data ownership의 약점을 개선하면 같은 유형의 복구가 더 안전해진다.

작은 개선을 다음 backup job과 drill에 반영하는 반복이 있어야 논리 export는 단순 파일이 아니라 실제 복구 능력이 된다. 파일 생성·보관·격리 import·기술 검증·업무 확인·cleanup까지 연결된 절차를 유지하는 것이 핵심이다.

복구 계획을 한 번 만들었다고 끝난 것도 아니다. schema가 바뀌고 사용자·권한이 늘며 backup 저장소와 도구 version이 바뀔 때마다 기존 가정을 확인해야 한다. 정기 drill의 목적은 모든 장애를 완벽히 재현하는 데 있지 않고, 현재의 파일·권한·문서·담당자가 실제로 이어지는지 작은 범위에서 증명하는 데 있다.

이렇게 남긴 검증 기록은 다음 변경에서 복구 범위와 투자 우선순위를 더 정확하게 정하는 근거가 된다.

결국 복구의 신뢰도는 파일 수보다 실제로 확인한 절차와 책임 있는 개선의 반복에서 나온다.

작은 drill이라도 꾸준히 수행하면 큰 사고의 불확실성을 줄일 수 있다.

준비는 복구 시간을 줄인다.

## 한계와 적용 기준 Q&A

### Q. 논리 export로 point-in-time 복구를 할 수 있나요?

A. export 파일 자체는 생성 시점의 논리 상태를 제공한다. 더 정밀한 시점 복구에는 사용 중인 Tibero의 물리 backup·archive log·복구 기능과 현재 운영 구성에 맞는 별도 절차가 필요할 수 있다. 논리 export만으로 모든 변경 이력을 재생할 수 있다고 가정하지 말아야 한다.

### Q. 개발 환경에 production export를 그대로 써도 되나요?

A. 일반적으로 개인정보·권한·접근 통제 때문에 위험할 수 있다. 목적에 필요한 최소 schema와 masked data를 사용하고, 승인된 격리 환경·보존 기간·접근 역할을 적용하는 편이 안전하다.

### Q. import가 성공했는데 application이 오류를 내는 이유는 무엇인가요?

A. 객체 의존성, synonym, privilege, sequence 값, 설정, 외부 system 상태가 빠졌을 수 있다. import 로그뿐 아니라 invalid object, 권한, 대표 application flow, 관련 batch를 함께 확인해야 한다.

## 마무리

Tibero 논리 백업과 복구는 dump 파일을 보관하는 일이 아니라, 어떤 객체·데이터·권한을 어떤 시점으로 되살릴지 결정하고 격리된 환경에서 검증하는 절차다. 전체 복구와 선택적 보정의 경계를 구분하고, export metadata·보안·import 충돌·업무 검증·정기 drill을 연결하면 논리 backup은 운영 복구 전략의 신뢰할 수 있는 한 축이 된다.

<h3 class="references-heading">참고 자료</h3>

- [Tibero 공식 문서](https://docs.tibero.com/)
- [TmaxTibero 제품 정보](https://www.tibero.com/)
- [NIST SP 800-34: Contingency Planning Guide](https://csrc.nist.gov/pubs/sp/800/34/r1/final)
- [OWASP: Logging Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html)
