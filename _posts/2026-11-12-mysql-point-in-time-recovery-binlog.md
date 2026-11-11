---
layout: post
title: "MySQL 시점 복구를 설계하는 법: Full Backup·Binary Log·PITR 검증의 기준"
categories: [DBA]
tags: [mysql, dba, backup, recovery, binary-log, pitr, innodb]
description: "MySQL Point-in-Time Recovery의 기반인 full backup과 binary log를 이해하고, 데이터 변경 사고에서 안전하게 복구·검증하는 절차를 설명합니다."
---

## 먼저 답하기

### Q. MySQL full backup만 있으면 데이터 삭제 사고를 복구할 수 있나요?

A. 백업을 만든 시점까지는 되돌릴 수 있지만, 그 뒤에 발생한 정상 변경까지 함께 잃을 수 있습니다. Point-in-Time Recovery(PITR, 시점 복구)는 full backup을 먼저 복원한 뒤 binary log에 기록된 변경을 목표 시각 또는 목표 event 직전까지 다시 적용해, 사고 직전 상태에 가깝게 만드는 방법입니다. 따라서 full backup과 끊기지 않은 binary log, 그리고 목표 지점을 안전하게 판단할 근거가 함께 있어야 합니다.

### Q. `mysqlbinlog`로 로그를 재생하면 바로 production에 적용해도 되나요?

A. 권장하지 않습니다. binary log에는 사고 전의 정상 변경뿐 아니라 사고를 일으킨 `DELETE`, 잘못된 `UPDATE`, 다른 서비스의 쓰기, 권한 변경도 들어 있을 수 있습니다. 먼저 격리된 복구 서버에서 full backup을 복원하고, 적절한 stop point까지 로그를 적용한 뒤 데이터와 애플리케이션 관점의 검증을 수행해야 합니다. production에 덮어쓸지, 필요한 row만 추출해 보정할지는 영향 범위와 최신 정상 변경의 가치에 따라 별도로 판단합니다.

## 먼저 알아둘 기반 기술

### Full backup, incremental backup, binary log

full backup은 특정 시점의 데이터베이스 전체 또는 필요한 데이터 범위를 복사한 기준점입니다. 논리 백업은 SQL 문장 형태로 schema와 row를 저장할 수 있고, 물리 백업은 InnoDB data file과 관련 파일을 복사해 더 큰 데이터셋을 빠르게 다루는 방식이 될 수 있습니다. 어떤 도구를 쓰든 복구 관점에서는 "언제의 일관된 상태를 만들었는가"와 "그 파일을 실제로 복원할 수 있는가"가 중요합니다.

binary log는 MySQL server가 데이터 변경을 기록하는 로그입니다. insert, update, delete, DDL(Data Definition Language) 같은 변경이 시간 순서로 남고, replication에도 사용됩니다. MySQL의 시점 복구는 보통 full backup으로 서버를 기준 시점으로 돌린 다음, 그 이후 binary log를 원하는 지점까지 적용하는 방식입니다. binary log가 없거나 중간 파일이 사라지면 full backup 이후의 변경을 재생할 수 없습니다.

incremental backup은 이전 backup 이후의 변경분을 별도로 보관해 복구 시간을 줄이거나 보존 정책을 구성하는 방식입니다. 하지만 binary log 기반 PITR과 같은 개념으로 섞어 생각하면 위험합니다. incremental chain의 순서, tool의 복구 절차, binary log의 보존 기간은 각각 확인해야 합니다. 팀은 자신이 쓰는 backup 도구가 어떤 파일을 만들고 어떤 순서로 restore하는지 runbook에 명확히 적어야 합니다.

### RPO와 RTO

RPO(Recovery Point Objective)는 사고가 났을 때 허용할 수 있는 데이터 손실 시점의 목표이고, RTO(Recovery Time Objective)는 서비스를 복구하는 데 허용할 수 있는 시간 목표입니다. 매일 새벽 full backup만 있고 binary log를 보관하지 않는다면 RPO는 마지막 backup 시각에 묶입니다. 반대로 binary log를 지속적으로 수집해도 restore와 검증에 다섯 시간이 걸린다면 RTO 요구를 만족하지 못할 수 있습니다. PITR을 도입하는 이유는 "로그를 남긴다"가 아니라 이 두 목표를 실제 절차로 충족하기 위해서입니다.

## PITR이 필요한 사고와 필요하지 않은 사고

PITR은 실수로 대량 row를 삭제했거나, 잘못된 batch update가 정상 값을 덮어썼거나, application bug가 짧은 시간 동안 잘못된 상태를 기록했을 때 특히 유용합니다. 예를 들어 운영자가 조건을 빠뜨린 `DELETE FROM orders`를 실행했다면, 사고 직전의 full backup과 이후 binary log로 격리 서버를 사고 직전까지 재생할 수 있습니다. 이때 목표는 무조건 production 전체를 과거로 돌리는 것이 아니라, 잃은 데이터와 이후 정상 변경을 비교해 가장 안전한 복구 방법을 고르는 것입니다.

반대로 storage 자체가 손상됐거나, host가 유실됐거나, ransomware가 backup 저장소까지 손댄 경우에는 단순 binary log 재생만으로 충분하지 않을 수 있습니다. replication lag, 잘못된 schema migration, 잘못된 권한 부여, application cache의 오래된 값도 원인과 영향 범위가 다릅니다. 먼저 장애가 데이터 내용의 논리적 오류인지, MySQL process나 storage의 물리적 오류인지, 외부 시스템까지 포함하는 업무 오류인지 분류해야 합니다. PITR은 만능 복구 버튼이 아니라 논리적 변경 이력을 활용하는 도구입니다.

## binary log 설정과 보존을 확인하는 법

PITR의 출발점은 binary logging이 실제로 켜져 있고 필요한 기간의 파일이 남아 있는지 확인하는 것입니다. `log_bin` 설정, binary log 파일 목록, 만료 정책, 저장 위치, 원격 수집 결과를 함께 점검합니다. 운영 환경의 설정을 바꾸기 전에는 버전별 공식 문서와 현재 replication·backup 구성을 확인해야 합니다. binary log를 갑자기 비활성화하거나 만료 시간을 짧게 바꾸면 복구 사슬과 replica 동기화에 영향을 줄 수 있습니다.

다음 명령은 현재 server에서 binary log 상태와 파일 목록을 살펴보는 예시다. 권한과 출력 정보의 민감성을 고려해, production에서는 승인된 운영 절차에 따라 실행해야 한다.

```sql
SHOW VARIABLES LIKE 'log_bin';
SHOW BINARY LOGS;
SHOW MASTER STATUS;
```

보존 기간은 backup 주기보다 길어야 한다는 단순 규칙만으로 정하기 어렵습니다. 사고를 발견하기까지 걸리는 시간, full backup 검증 실패를 다시 만들 수 있는 여유, 법적·보안 보존 요구, 저장 공간, replication 지연을 같이 봐야 합니다. 예를 들어 주간 full backup을 쓴다면 binary log가 그 backup보다 먼저 삭제되지 않도록 해야 하고, 월말 정산 오류를 며칠 뒤 발견할 가능성이 있다면 그 탐지 지연도 포함해야 합니다. 실제 숫자는 업무별 목표에서 결정하며, 만료 작업 자체가 예상대로 동작하는지 경보로 확인합니다.

## 복구 지점을 찾는 과정

사고 시각을 "오전 10시쯤"으로만 알고 바로 로그를 재생하면, 사고 SQL을 포함하거나 필요한 정상 변경을 빼먹을 수 있습니다. 먼저 application log, audit log, deployment 기록, 사용자 신고 시각, database connection 로그, binary log의 timestamp를 모아 시간 창을 좁힙니다. server와 application의 timezone이 다를 수 있고, 클라이언트 시계가 정확하지 않을 수도 있으므로 한 가지 시간만 절대 기준으로 믿지 않습니다.

`mysqlbinlog`는 binary log를 사람이 읽을 수 있는 형태로 살펴보거나 SQL stream으로 변환하는 도구입니다. row 기반 logging에서는 원래 SQL 문장이 그대로 보이지 않고 row event로 기록될 수 있습니다. statement 기반 logging에서는 실행 문장이 보일 수 있지만, 비결정적 함수나 환경 차이의 의미를 주의해야 합니다. 중요한 것은 형식의 우열이 아니라, 현재 `binlog_format`과 workload에 맞춰 사고 이벤트를 식별하고 재생 결과를 검증하는 것입니다.

파일 이름과 position 또는 timestamp는 stop point 후보가 됩니다. timestamp는 이해하기 쉽지만 같은 초에 여러 transaction이 몰리면 경계가 모호할 수 있습니다. position은 더 정밀할 수 있으나 정확한 log file과 event 순서를 함께 관리해야 합니다. transaction 경계 중간에서 멈추면 데이터 정합성이 깨질 수 있으므로, 단순히 눈에 보이는 시간 직전에서 끊기보다 commit 단위와 도구 옵션의 의미를 확인합니다.

## 안전한 복구 절차: 격리 서버에서 먼저 재생하기

가장 안전한 절차는 별도의 복구 인스턴스에 full backup을 복원하는 것부터 시작합니다. 이 인스턴스는 production application이 연결할 수 없고, 외부 이메일·결제·webhook을 호출하지 않도록 network를 제한합니다. 복원 대상 MySQL version, charset, keyring 또는 encryption 설정, 계정·권한 정보가 backup 방식과 맞는지 확인합니다. production data를 복사하므로 접근 권한과 저장소 암호화도 production 수준으로 다뤄야 합니다.

full backup을 복원한 다음에는 backup 완료 시점 이후의 binary log를 순서대로 적용합니다. 아래는 형식만 보여 주는 예시이며, 실제 파일·position·stop datetime은 사고 조사 결과와 runbook을 기준으로 결정해야 합니다.

```bash
mysqlbinlog --start-datetime='2026-11-12 08:00:00' \
  --stop-datetime='2026-11-12 10:14:59' \
  mysql-bin.000123 mysql-bin.000124 | mysql -u recovery_user -p
```

이 명령을 production shell에서 습관처럼 실행해서는 안 됩니다. 특히 `mysql` client가 어느 host를 가리키는지, 적용 계정이 어떤 권한을 갖는지, log 파일이 완전한지, 복원 서버가 read-only 보호를 해제해야 하는지 확인해야 합니다. pipeline을 실행하기 전에는 출력 파일을 별도로 저장해 review하거나, 제한된 샘플 로그로 dry run 성격의 검토를 하는 과정이 필요합니다.

## 업무 예시: 잘못된 일괄 삭제 뒤 주문 데이터 복구

주문 보관 정책을 수정하던 중 운영 batch가 날짜 조건을 잘못 적용해 최근 주문 일부를 삭제했다고 가정합니다. 즉시 해야 할 일은 production에 다시 쓰기 전에 delete가 언제 시작·끝났는지와 영향을 받은 주문 범위를 추정하는 것입니다. batch job의 실행 ID, deployment SHA, application audit log, MySQL binary log 위치를 확보하고, 같은 batch를 재실행하지 않도록 job을 중지합니다. 단, 성급하게 전체 서비스를 read-only로 만들지 여부는 현재 추가 쓰기가 복구 판단을 얼마나 어렵게 만드는지와 업무 영향에 따라 incident 책임자가 결정해야 합니다.

격리 복구 서버에서는 최근 full backup을 복원하고, 삭제 직전까지 binary log를 재생합니다. 그 서버에서 삭제된 것으로 의심되는 주문 ID 수, 주문·결제·배송 테이블의 관계, 고객별 상태를 확인합니다. 원래 production은 삭제 이후에도 정상 주문을 계속 받았을 수 있으므로, 격리 서버의 과거 상태를 그대로 production에 덮어쓰면 새 주문을 잃을 위험이 있습니다. 흔한 선택지는 복구 서버에서 필요한 row만 추출하고, production의 현재 상태와 충돌을 검토한 뒤 승인된 보정 transaction으로 넣는 방법입니다.

이 예시에서 검증은 row count 하나로 끝나지 않습니다. 주문 row가 돌아와도 결제 capture, 재고 예약, 배송 요청, 분석 이벤트가 별도 시스템에 남아 있을 수 있습니다. 주문 상태 전이와 외래 키 관계, 고객 화면 조회, 후속 worker의 중복 처리 방지까지 확인해야 합니다. 데이터베이스 복구와 업무 복구의 경계를 문서에 적어야 당직자가 "row가 보인다"를 서비스 정상으로 오해하지 않습니다.

## 복구 뒤 검증: 데이터와 업무를 나눠 확인하기

기술적 검증은 MySQL이 기동되는지, 필요한 schema와 table이 존재하는지, row count가 예상 범위인지, foreign key와 unique constraint가 깨지지 않았는지부터 시작합니다. checksum이나 비교 query를 쓸 때는 큰 table 전체를 production 부하가 높은 시간에 스캔하지 않도록 주의합니다. 복구 서버에서 primary key 범위, 샘플 레코드, 최근 변경 시각, 중요한 집계 값을 비교해 차이를 좁히는 방식이 실용적입니다.

업무 검증은 실제 사용자 경로를 확인합니다. 주문 데이터라면 고객이 주문 목록과 상세를 볼 수 있는지, 취소 가능한 상태가 맞는지, 결제와 배송 상태가 모순되지 않는지, 고객 지원 도구에서 같은 정보를 읽는지 살펴봅니다. 이 단계에는 개발자뿐 아니라 업무 담당자나 support 담당자가 필요한 이유가 있습니다. 데이터베이스 column 값이 맞아도 업무상 "환불 완료"와 "주문 취소"의 조합이 허용되지 않을 수 있기 때문입니다.

검증 결과는 복구 시각, 사용한 backup 식별자, 적용한 binary log 범위, 확인 query, 비교 결과, 제외한 데이터, 승인자를 포함해 기록합니다. 이는 나중에 책임을 묻기 위한 문서보다 다음 사고에서 더 빠르게 판단하기 위한 runbook 개선 자료입니다. 민감한 고객 정보나 password, connection string은 이 기록에 넣지 않습니다.

## replication과 PITR을 혼동하지 않기

replica는 primary의 변경을 따라가므로 장애 대응에 도움이 될 수 있지만, 논리적 삭제도 복제될 수 있습니다. 삭제 사고를 뒤늦게 발견했을 때 replica가 이미 같은 delete를 적용했다면 과거 상태를 보존하지 못합니다. replication delay를 의도적으로 두는 전략은 일부 조직에서 검토할 수 있지만, 지연 동안 읽기 일관성·failover·운영 복잡도가 달라집니다. 이것만으로 backup과 PITR을 대체할 수는 없습니다.

또한 replica promotion, failover, binary log 파일 위치 변경 뒤에는 어느 server의 log를 어떤 순서로 사용해야 하는지 더 복잡해집니다. topology와 GTID(Global Transaction Identifier) 사용 여부, backup이 어느 node에서 만들어졌는지, failover 시점이 언제인지가 복구 계획에 들어가야 합니다. 복잡한 replication 환경이라면 실제 장애 전에 작은 restore drill로 이력을 따라갈 수 있는지 확인하는 것이 문서만 읽는 것보다 중요합니다.

## 정기 복구 연습과 관찰 지표

backup 성공 로그는 복구 성공 증거가 아닙니다. 정기적으로 격리 환경에 backup을 복원하고, 선택한 binary log 구간을 적용해, 핵심 table과 업무 흐름을 확인하는 restore drill이 필요합니다. 이 연습에서는 파일 다운로드, decrypt, server 기동, log 적용, 검증, 결과 공유까지 걸린 시간을 측정해 RTO 가정이 현실적인지 확인할 수 있습니다. 직접 운영 환경에서 측정하지 않았다면 목표 시간과 연습 결과를 혼동해 쓰지 말고, 계획과 관찰 사실을 구분합니다.

관찰 지표는 마지막 검증된 full backup 시각, 마지막 수집된 binary log 시각, 백업 파일 checksum 검증 결과, 저장소 용량, binary log 만료 예정, 복구 연습 성공 여부 정도로 시작할 수 있습니다. 경보에는 cluster나 instance 이름, 마지막 정상 시각, 실패 단계, runbook 링크를 넣되 credential과 고객 데이터를 포함하지 않습니다. backup job이 성공했지만 object storage 업로드가 실패한 경우처럼 단계별 성공을 구분하는 것이 중요합니다.

## Backup 일관성과 복구 가능성을 구분하기

백업 파일이 존재한다는 사실과 그 파일이 일관된 복구 기준점이라는 사실은 다르다. 실행 중인 InnoDB 데이터 파일을 운영체제 복사만으로 가져오면, table space와 redo log의 관계, 복사 순서, 변경 중인 page 때문에 기동 시점의 정합성을 보장하기 어렵다. 논리 backup도 transaction snapshot을 어떤 방식으로 잡았는지, 대용량 table을 export하는 동안 schema가 바뀌지 않았는지, stored program과 event·trigger를 포함했는지에 따라 복구 범위가 달라진다. 팀이 쓰는 도구의 "성공" 메시지를 그대로 믿기보다 해당 도구가 만드는 backup의 일관성 조건을 공식 문서와 실제 restore로 확인해야 한다.

PITR에서 특히 중요한 시각은 full backup이 논리적으로 끝난 시각과 binary log 재생을 시작해야 하는 지점이다. backup 도구에 따라 log position이나 GTID set을 metadata로 남길 수 있으며, 이 metadata가 없으면 어느 로그부터 적용할지 추정해야 한다. 추정은 중복 적용 또는 변경 누락을 만들 수 있다. backup 파일, metadata, checksum, MySQL version, backup 도구 version을 한 묶음으로 보관하면 나중에 파일만 남고 출발점을 모르는 상황을 줄일 수 있다.

복구 연습에서는 의도적으로 오래된 backup 하나를 골라 실제로 기동해 보는 것이 좋다. 최신 파일만 시험하면 보존 정책이 삭제 직전의 파일이나 다른 storage tier의 파일을 복원하지 못하는 문제를 놓칠 수 있다. 다만 오래된 production backup에는 더 많은 민감 정보가 들어 있을 수 있으므로, restore 환경의 접근 제어와 결과 데이터의 폐기 절차를 함께 적용한다. 백업은 보관 기간이 길수록 안전하다는 단순한 문제가 아니라, 사용할 수 있고 안전하게 관리되는 기간을 정하는 문제다.

## GTID와 file position의 차이를 이해하기

GTID(Global Transaction Identifier)는 transaction에 부여되는 식별자를 이용해 replication과 변경 이력을 다루는 방식이다. topology가 바뀌거나 replica가 승격된 환경에서는 단순한 `mysql-bin.000123`과 position만으로 transaction 관계를 추적하기 어려울 수 있다. GTID를 사용하면 어떤 transaction이 이미 적용됐는지를 식별하는 데 도움이 되지만, PITR의 판단과 검증이 자동으로 해결되는 것은 아니다. 여전히 사고 transaction의 범위, backup이 가진 GTID set, 복구 대상의 실행 이력, skip 또는 replay의 의미를 이해해야 한다.

file position 방식은 단일 instance에서 직관적으로 보일 수 있다. 그러나 binary log rotate, failover, 여러 server의 log, backup 시점의 position 기록이 얽히면 사람이 번호만 보고 순서를 결정하기 위험하다. 현재 운영에서 GTID를 쓰는지, backup과 replica가 어떤 방식으로 관리되는지, failover 뒤 어떤 server가 source였는지를 runbook 첫 부분에 적어 둔다. 새 복구 절차를 사고 중에 배우지 않도록, 평소 격리된 환경에서 현재 topology와 같은 조건의 연습을 해 보는 것이 중요하다.

GTID를 도입하거나 설정을 바꾸는 일도 PITR만을 위한 단순 변경으로 취급해서는 안 된다. replication 호환성, server version, application의 operational procedure에 영향을 줄 수 있다. 이 글의 핵심은 특정 모드를 권장하는 것이 아니라, 현재 사용하는 식별 방식이 backup metadata와 restore 절차에서 어떻게 이어지는지 증명하는 것이다.

## 권한, 암호화, key material을 복구 계획에 넣기

database backup에는 고객 정보, account 정보, schema, 경우에 따라 credential 관련 데이터가 포함될 수 있다. backup 저장소의 read 권한은 production database read 권한과 비슷한 민감도로 취급해야 한다. object storage bucket을 공개로 두거나, 복구 담당자 모두에게 장기 access key를 나눠 주는 방식은 파일은 복구할 수 있어도 보안 사고를 만들 수 있다. 최소 권한 역할, 다중 인증, 접근 audit log, 짧은 수명의 credential, 별도 복구 승인 경로를 마련한다.

암호화된 backup은 key가 있어야 의미 있게 복구할 수 있다. key를 backup 파일과 같은 bucket에 같은 권한으로 저장하면 암호화의 효과가 약해지고, key를 지나치게 분리해 두면 장애 시점에 찾지 못해 RTO가 늘어난다. key management system의 접근 절차, key version, rotation 시 과거 backup을 decrypt하는 방법, break-glass 권한을 runbook에 포함해야 한다. 실제 key 값이나 password를 문서·채팅·ticket에 적어서는 안 된다.

복구를 위해 임시로 만든 MySQL 계정도 종료 작업의 대상이다. 격리 환경에서 사용한 관리자 계정, dump 파일, 임시 SQL, 복구 결과 export, audit log의 보존 기간을 정하고 작업 뒤 회수한다. 사고 대응의 속도를 위해 보안을 포기할 필요는 없다. 미리 권한과 승인 경로를 시험해 두면 실제 사고에서 비밀을 복사해 공유하는 더 위험한 지름길을 피할 수 있다.

## 복구 전략을 선택하는 의사결정 표

논리적 삭제 사고를 만났을 때 선택지는 보통 세 가지다. 첫째, full backup과 binary log를 이용해 격리 서버에서 과거 상태를 만들고 필요한 row만 production에 보정한다. 둘째, 짧은 maintenance window를 잡고 production 전체를 특정 시점으로 restore한다. 셋째, database는 현재 상태를 유지하고 application 또는 외부 시스템의 원본에서 데이터를 재생성한다. 어느 방법이 정답인지는 삭제된 데이터의 양보다 삭제 이후 정상 변경의 양, 업무 중단 허용 시간, 관계된 외부 시스템, 검증할 수 있는 원본의 유무에 달려 있다.

예를 들어 새 주문이 계속 들어오는 24시간 서비스에서 전체 restore는 삭제 row를 되돌릴 수 있어도 그 사이 정상 주문을 잃게 할 수 있다. 이 경우 격리 서버에서 복구한 row를 비교·추출하는 방법이 더 느리지만 위험이 작을 수 있다. 반대로 staging database처럼 외부 side effect가 없고 최근 변경이 적은 환경은 전체 restore가 단순할 수 있다. incident commander가 이 판단을 할 수 있도록, runbook에 영향 범위·마지막 정상 시각·정상 변경량·외부 의존성·rollback 가능성을 질문으로 둔다.

이 결정은 DBA 혼자 내리지 않는다. application owner는 데이터 의미와 재생성 가능성을, 업무 담당자는 고객·정산 영향과 우선순위를, security 담당자는 data exposure와 접근 절차를 판단한다. 기술 복구는 빠른 명령 실행이 아니라 정보에 근거한 선택이다. 의사결정 기록은 나중에 같은 유형의 사고에서 더 빠른 기준이 된다.

## Schema 변경과 DDL의 위험

binary log에는 row 변경뿐 아니라 schema 변경이 기록될 수 있다. full backup 이후 `ALTER TABLE`, index 생성, column 이름 변경, stored procedure 수정이 있었다면, 과거 데이터를 현재 schema에 바로 넣는 과정에서 type·default·constraint가 맞지 않을 수 있다. 반대로 과거 시점까지 로그를 재생하면 이후에 적용한 schema migration도 함께 되돌아갈 수 있다. 따라서 사고 조사에서 application deploy와 migration history를 binary log 조사와 나란히 본다.

특히 destructive migration은 data recovery와 강하게 연결된다. column drop, type 축소, table rename 같은 변경은 rollback script가 있더라도 데이터가 보존됐는지 별도 확인이 필요하다. migration을 배포할 때는 backup 완료 여부, 예상한 schema version, rollback 가능성, 대응 runbook을 함께 review하는 습관이 도움이 된다. 이는 모든 migration을 느리게 하자는 뜻이 아니라, 돌이킬 수 없는 변경을 일반 코드 변경과 같은 가벼운 취급으로 두지 않자는 뜻이다.

복구 환경에는 application binary를 연결하지 않거나 read-only로 시작하는 편이 안전하다. 오래된 schema에 최신 application이 접속하면 background job이나 migration tool이 의도치 않게 쓰기를 할 수 있다. 데이터 검증용 계정과 application runtime 계정을 분리하고, 외부 webhook·scheduler를 차단하면 복구 서버가 새로운 변경을 만들 위험을 낮출 수 있다.

## 테스트와 drill을 작은 단위로 반복하기

PITR 연습은 실제 대규모 사고를 연기하는 일이 아니다. 처음에는 작은 sample database에서 full backup 하나를 restore하고, 확인 가능한 binary log 구간 하나를 적용한 뒤, 특정 row가 예상 시점의 값인지 보는 것으로 시작할 수 있다. 다음에는 application test data와 두 개 이상의 관련 table을 포함하고, 이후에는 encryption·replication·object storage 다운로드처럼 실제와 가까운 조건을 추가한다. 단계를 나누면 어느 구성 요소가 RTO를 늘리는지 분명해진다.

연습 결과에는 성공 여부 외에 준비 시간, 다운로드 시간, restore 시간, log 적용 시간, 검증 시간, 사람의 승인 대기 시간을 구분해 기록한다. 예를 들어 backup restore는 빠른데 접근 권한 승인에 오래 걸렸다면 storage 성능보다 운영 절차가 병목이다. 반대로 데이터는 복원됐지만 업무 검증을 할 수 없다면 sample query와 담당자 참여 절차가 부족한 것이다. 목표 RTO는 문서에 쓰는 숫자가 아니라 이런 반복 결과로 조정해야 한다.

drill이 끝난 후에는 격리 환경과 임시 파일을 제거하고, 사용한 권한을 회수하며, 발견한 gap을 backlog에 넣는다. 이 정리는 단순 청소가 아니라 민감 데이터 잔존과 다음 연습의 false positive를 막는다. 같은 drill을 사람이 바뀌어도 수행할 수 있어야 한다. 한 명의 기억에만 있는 복구 절차는 담당자가 부재한 장애에서 가장 먼저 실패한다.

## 관찰, 경보, 변경 관리

backup job이 exit code 0으로 끝났다는 지표 하나만으로는 부족하다. 마지막 검증된 full backup 시각, 마지막 수집된 binary log 시각, backup metadata 존재 여부, checksum, 원격 저장소 업로드, 남은 저장 공간, binary log 만료 예정 시각을 각기 관찰한다. 마지막 log가 RPO보다 오래됐거나 backup이 생성됐지만 remote copy가 없으면 사람이 행동할 수 있는 경보를 만든다. 알림에는 instance 이름·실패 단계·마지막 정상 시각·runbook 링크를 넣고 password와 고객 정보는 넣지 않는다.

MySQL 설정 변경, backup tool upgrade, storage lifecycle rule 변경, encryption key rotation, replica promotion은 모두 복구 가능성에 영향을 준다. 변경 요청에 "PITR 영향 확인" 항목을 넣으면 backup과 별개로 운영된다는 착각을 줄일 수 있다. 큰 변경 뒤에는 다음 정기 drill까지 기다리지 말고 최소 restore 검증을 수행하는 것이 좋다. 예를 들어 lifecycle rule을 바꾼 날에는 필요한 기간의 binary log 파일이 실제로 남아 있는지 확인한다.

## 용량 계획과 비용을 복구 요구와 연결하기

binary log 보존 기간을 늘리면 복구 창은 넓어지지만 storage 용량과 전송 비용도 변한다. 특히 대량 batch, index 생성, 대규모 update가 있는 기간에는 평소보다 log 생성량이 급증할 수 있다. 평균 하루 용량만으로 계산하지 말고 월말 처리·campaign·migration 같은 peak 구간을 포함해 여유를 둔다. 저장소가 가득 차 binary log 기록 자체가 영향을 받는 상황은 PITR 문제를 넘어 write availability 문제로 이어질 수 있으므로, 사용량·증가율·만료 예정 파일을 관찰한다.

비용을 줄이기 위해 오래된 log를 너무 빨리 삭제하면 사고를 발견한 뒤 가장 필요한 구간이 없어질 수 있다. 반대로 모든 파일을 가장 비싼 storage에 무기한 두는 것도 답이 아닐 수 있다. 최근 복구 창은 빠르게 접근 가능한 저장소에, 더 오래된 감사·복구 요구는 적절한 tier에 두는 방식을 검토할 수 있다. 다만 tier 이동 뒤 실제 download와 restore 시간이 RTO 안에 드는지는 drill로 확인해야 한다. 보존 정책은 비용 설정이 아니라 복구 약속의 일부다.

## 운영 사고 중 의사소통과 변경 동결

데이터 사고가 의심될 때 첫 메시지는 "전체 restore를 시작한다"가 아니라, 현재 쓰기 작업을 계속해도 되는지와 무엇을 보존해야 하는지를 정리하는 것이어야 한다. incident channel에는 발견 시각, 영향이 의심되는 기능, 마지막 정상 확인 시각, 이미 중지한 job, backup과 binary log의 위치, 다음 판단 시각을 간단히 공유한다. 지나친 세부 정보나 credential은 이 채널에 남기지 않는다. 이 기록이 있어야 교대 담당자도 왜 특정 log 파일을 보존했고 어떤 작업을 멈췄는지 이해할 수 있다.

필요하다면 영향을 주는 batch·migration·scheduler만 선택적으로 멈추고, 모든 서비스를 무조건 중단하기 전에 추가 정상 변경과 중단 비용을 비교한다. 이 결정은 서비스마다 다르므로 사전에 하나의 정답을 정하기보다, 누가 승인하고 어떤 조건에서 read-only 또는 maintenance mode로 전환하는지 정해 둔다. 복구 서버에서 검증한 데이터를 production에 넣기 전에는 두 번째 검토자와 rollback 방법을 확인한다. 급한 상황일수록 한 줄의 SQL이 되돌릴 수 없는 새 사고를 만들기 쉽다.

## 복구 문서를 유지하는 최소 단위

runbook은 수십 페이지의 문서일 필요가 없다. 누가 복구를 선언하는지, 어떤 backup metadata를 찾는지, 격리 서버를 어떻게 준비하는지, binary log의 어느 지점을 확인하는지, 검증과 cleanup을 누가 맡는지만 최신 상태로 있어도 사고 대응의 출발점이 된다. 명령어는 복사하기 전에 host·version·파일 이름을 확인하도록 변수와 주의점을 남기고, 실제 비밀 값은 문서에 넣지 않는다. 큰 인프라·도구 변경 뒤에는 이 문서를 함께 review하고 다음 drill에서 검증한다.

## 복구 완료의 기준을 미리 합의하기

MySQL process가 기동되고 몇 개 query가 성공했다고 복구를 완료로 선언하면 안 된다. 기술적으로는 필요한 schema와 data range가 존재하는지, binary log 적용 범위가 기록과 맞는지, connection·권한·replica 상태가 기대와 맞는지를 확인한다. 업무적으로는 고객이 중요한 기능을 사용할 수 있는지, 정산·배송·알림 같은 후속 시스템과 모순이 없는지 확인한다. 이 기준과 승인자를 사고 전에 합의하면, 압박이 큰 상황에서도 "어디까지 확인하면 정상으로 돌려도 되는가"를 더 명확하게 판단할 수 있다.

## 한계와 적용 기준 Q&A

### Q. PITR을 하면 모든 테이블을 정확히 과거로 돌릴 수 있나요?

A. full backup의 일관성, binary log의 완전성, 목표 지점 판단, 복구 시점의 server 설정에 달려 있습니다. 외부 결제·캐시·검색 인덱스·파일 저장소처럼 MySQL 밖에서 일어난 변경은 자동으로 되돌아가지 않습니다. 데이터베이스 복구 범위와 업무 전체 복구 범위를 분리해 설계해야 합니다.

### Q. 삭제 SQL 한 줄만 binary log에서 빼고 나머지는 재생하면 되나요?

A. 단순해 보여도 transaction 순서, trigger, stored program, 후속 변경, replication 형식 때문에 위험할 수 있습니다. 우선 사고 직전까지 재생한 격리 서버에서 필요한 데이터를 추출하고, 현재 production과 비교해 보정 방법을 검토하는 편이 안전합니다. 특정 event를 건너뛰는 방법은 충분한 검증과 승인 없이 production에 적용하지 마세요.

### Q. binary log 보존 기간을 길게 하면 backup은 줄여도 되나요?

A. 아닙니다. PITR은 복원할 full backup을 전제로 합니다. binary log만으로 새 서버를 원하는 과거 상태로 만들 수 있다고 가정하면 backup 손상이나 초기 기준점 부재에서 복구가 막힐 수 있습니다. full backup 검증과 log 보존은 함께 관리해야 합니다.

### Q. 언제 PITR 절차를 단순하게 시작할 수 있나요?

A. 단일 MySQL instance와 비교적 작은 데이터셋이라면, 먼저 검증된 full backup 하나와 필요한 기간의 binary log를 별도 저장소에 보관하고 격리 restore drill을 문서화하는 것부터 시작할 수 있습니다. 다중 primary, 복잡한 replication, 암호화 key, 대용량 데이터가 있다면 도구와 topology에 맞춘 전문 runbook 및 정기 훈련이 더 중요합니다.

## 마무리

MySQL 시점 복구는 full backup과 binary log를 보유했다는 선언이 아니라, 사고 전 상태를 찾고 격리된 서버에서 재생하며 현재 업무 데이터와 안전하게 합치는 능력이다. binary log 보존·목표 지점 식별·복구 환경 격리·데이터와 업무 검증·정기 restore drill을 하나의 사슬로 설계해야 한다. 가장 좋은 복구 계획은 사고가 난 뒤 처음 읽는 긴 문서가 아니라, 평소에 작게 연습하고 최신 구성에 맞춰 갱신한 실행 가능한 절차다.

<h3 class="references-heading">참고 자료</h3>

- [MySQL 8.4 Reference Manual: Point-in-Time Recovery](https://dev.mysql.com/doc/refman/8.4/en/point-in-time-recovery.html)
- [MySQL 8.4 Reference Manual: The Binary Log](https://dev.mysql.com/doc/refman/8.4/en/binary-log.html)
- [MySQL 8.4 Reference Manual: mysqlbinlog](https://dev.mysql.com/doc/refman/8.4/en/mysqlbinlog.html)
- [MySQL 8.4 Reference Manual: Backup and Recovery](https://dev.mysql.com/doc/refman/8.4/en/backup-and-recovery.html)
