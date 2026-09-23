\set ON_ERROR_STOP 0
insert into auth.users values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','a@x.nz'),('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','b@x.nz');
-- user A
set role authenticated; select set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',false);
insert into batches (id,name) values ('11111111-1111-4111-8111-111111111111','A batch');
insert into items (id,batch_id) values ('22222222-2222-4222-8222-222222222222','11111111-1111-4111-8111-111111111111');
insert into photos (item_id, storage_path) values ('22222222-2222-4222-8222-222222222222','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/2/p.jpg');
select 'A sees items', count(*) from items;
insert into settings (prefs) values ('{"x":1}');
\echo '--- A: photo path in B folder (expect error)'
insert into photos (item_id, storage_path) values ('22222222-2222-4222-8222-222222222222','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/x.jpg');
\echo '--- A: set own ai_usage (expect permission denied)'
insert into ai_usage (user_id, calls) values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', -1000);
\echo '--- A: call quota fn (expect permission denied)'
select consume_ai_quota('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 999999);
-- user B
select set_config('request.jwt.claim.sub','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',false);
select 'B sees A items/batches/photos', (select count(*) from items),(select count(*) from batches),(select count(*) from photos);
select 'B sees A settings', count(*) from settings;
\echo '--- B: write settings as A (expect RLS error)'
insert into settings (user_id, prefs) values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '{}');
\echo '--- B: call usage fn (expect permission denied)'
select record_ai_usage('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 0, 0, -100, true);
\echo '--- B: add item to A batch (expect error)'
insert into items (batch_id) values ('11111111-1111-4111-8111-111111111111');
\echo '--- B: forge user_id (expect RLS error)'
insert into batches (name,user_id) values ('x','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
update items set title='hacked'; select 'B updated rows (expect 0)';
\echo '--- B: steal A item by moving to own batch'
insert into batches (id,name) values ('33333333-3333-4333-8333-333333333333','B batch');
update items set batch_id='33333333-3333-4333-8333-333333333333' where id='22222222-2222-4222-8222-222222222222';
\echo '--- B: add photo to A item (expect error)'
insert into photos (item_id, storage_path) values ('22222222-2222-4222-8222-222222222222','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/y.jpg');
\echo '--- storage: B write into A folder (expect RLS error), own folder ok'
insert into storage.objects (bucket_id,name) values ('photos','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/i/p.jpg');
insert into storage.objects (bucket_id,name) values ('photos','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/i/p.jpg');
select 'B sees objects', count(*) from storage.objects;
-- anon
reset role; set role anon;
\echo '--- anon read (expect permission denied)'
select count(*) from items;
reset role; set role service_role;
select 'quota', consume_ai_quota('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 2), consume_ai_quota('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 2), consume_ai_quota('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 2);
select record_ai_tokens('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 1000, 200, true);
select 'usage', calls, input_tokens, output_tokens from ai_usage;
reset role;
select 'A item title still', title, batch_id from items;
