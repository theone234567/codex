package nz.co.simple.panasonicremote;

import android.app.*;
import android.os.*;
import android.content.*;
import android.net.wifi.WifiManager;
import android.graphics.Color;
import android.view.*;
import android.widget.*;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.*;
import java.util.regex.*;

public class MainActivity extends Activity {
    private EditText ip; private TextView status; private final ExecutorService io = Executors.newCachedThreadPool();
    private static final int PORT=55000;
    private static final String URN="panasonic-com:service:p00NetworkControl:1";

    @Override public void onCreate(Bundle b){ super.onCreate(b); buildUi(); }

    private void buildUi(){
        ScrollView scroll=new ScrollView(this); LinearLayout root=new LinearLayout(this); root.setOrientation(LinearLayout.VERTICAL); root.setPadding(24,24,24,40); scroll.addView(root);
        TextView title=new TextView(this); title.setText("Panasonic Wi-Fi Remote"); title.setTextSize(25); title.setTextColor(Color.BLACK); title.setPadding(0,0,0,12); root.addView(title);
        TextView note=new TextView(this); note.setText("Phone and TV must be on the same Wi-Fi. Tap FIND TV first."); note.setTextSize(15); root.addView(note);
        LinearLayout connect=new LinearLayout(this); connect.setOrientation(LinearLayout.HORIZONTAL); ip=new EditText(this); ip.setHint("TV IP e.g. 192.168.1.50"); ip.setSingleLine(); connect.addView(ip,new LinearLayout.LayoutParams(0,WRAP,1)); Button find=button("FIND TV"); connect.addView(find); root.addView(connect);
        status=new TextView(this); status.setText("Not connected"); status.setPadding(0,6,0,18); root.addView(status); find.setOnClickListener(v->discover());

        addRow(root,new String[]{"POWER","INPUT","MUTE"},new String[]{"NRC_POWER-ONOFF","NRC_CHG_INPUT-ONOFF","NRC_MUTE-ONOFF"});
        addRow(root,new String[]{"VOL +","HOME","CH +"},new String[]{"NRC_VOLUP-ONOFF","NRC_HOME-ONOFF","NRC_CH_UP-ONOFF"});
        addRow(root,new String[]{"VOL −","MENU","CH −"},new String[]{"NRC_VOLDOWN-ONOFF","NRC_MENU-ONOFF","NRC_CH_DOWN-ONOFF"});
        addRow(root,new String[]{"","▲",""},new String[]{"","NRC_UP-ONOFF",""});
        addRow(root,new String[]{"◀","OK","▶"},new String[]{"NRC_LEFT-ONOFF","NRC_ENTER-ONOFF","NRC_RIGHT-ONOFF"});
        addRow(root,new String[]{"BACK","▼","EXIT"},new String[]{"NRC_RETURN-ONOFF","NRC_DOWN-ONOFF","NRC_CANCEL-ONOFF"});
        addRow(root,new String[]{"1","2","3"},new String[]{"NRC_D1-ONOFF","NRC_D2-ONOFF","NRC_D3-ONOFF"});
        addRow(root,new String[]{"4","5","6"},new String[]{"NRC_D4-ONOFF","NRC_D5-ONOFF","NRC_D6-ONOFF"});
        addRow(root,new String[]{"7","8","9"},new String[]{"NRC_D7-ONOFF","NRC_D8-ONOFF","NRC_D9-ONOFF"});
        addRow(root,new String[]{"INFO","0","GUIDE"},new String[]{"NRC_INFO-ONOFF","NRC_D0-ONOFF","NRC_EPG-ONOFF"});
        setContentView(scroll);
    }
    private static final int WRAP=ViewGroup.LayoutParams.WRAP_CONTENT;
    private Button button(String text){ Button b=new Button(this); b.setText(text); b.setMinHeight(58); return b; }
    private void addRow(LinearLayout root,String[] labels,String[] keys){ LinearLayout row=new LinearLayout(this); row.setOrientation(LinearLayout.HORIZONTAL); for(int i=0;i<3;i++){ if(labels[i].isEmpty()){ Space s=new Space(this); row.addView(s,new LinearLayout.LayoutParams(0,70,1)); } else { Button b=button(labels[i]); final String k=keys[i]; b.setOnClickListener(v->sendKey(k)); row.addView(b,new LinearLayout.LayoutParams(0,70,1)); }} root.addView(row); }

    private void discover(){ status.setText("Searching Wi-Fi for Panasonic TV…"); io.execute(()->{
        WifiManager wm=(WifiManager)getApplicationContext().getSystemService(WIFI_SERVICE); WifiManager.MulticastLock lock=wm.createMulticastLock("panasonic-discovery"); lock.setReferenceCounted(false); lock.acquire();
        LinkedHashSet<String> found=new LinkedHashSet<>();
        try(DatagramSocket s=new DatagramSocket()){ s.setSoTimeout(2500); String q="M-SEARCH * HTTP/1.1\r\nHOST:239.255.255.250:1900\r\nMAN:\"ssdp:discover\"\r\nMX:1\r\nST:urn:panasonic-com:device:p00RemoteController:1\r\n\r\n"; byte[] data=q.getBytes(StandardCharsets.UTF_8); s.send(new DatagramPacket(data,data.length,InetAddress.getByName("239.255.255.250"),1900)); long end=System.currentTimeMillis()+2800; while(System.currentTimeMillis()<end){ try{ byte[] buf=new byte[4096]; DatagramPacket p=new DatagramPacket(buf,buf.length); s.receive(p); String r=new String(p.getData(),0,p.getLength(),StandardCharsets.UTF_8); if(r.toLowerCase(Locale.US).contains("panasonic")||r.contains("p00RemoteController")) found.add(p.getAddress().getHostAddress()); }catch(SocketTimeoutException e){ break; }}
        }catch(Exception e){} finally { if(lock.isHeld()) lock.release(); }
        runOnUiThread(()->{ if(found.isEmpty()) status.setText("No TV found. If you know its IP, type it above. TV network remote control may need to be enabled."); else { String h=found.iterator().next(); ip.setText(h); status.setText("Found Panasonic TV: "+h+" — try VOL +"); }});
    }); }

    private void sendKey(String key){ String host=ip.getText().toString().trim(); if(host.isEmpty()){ status.setText("Tap FIND TV first, or enter the TV IP address."); return; } status.setText("Sending "+key.replace("NRC_","").replace("-ONOFF","")+"…"); io.execute(()->{
        try { String body="<?xml version=\"1.0\" encoding=\"utf-8\"?><s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\" s:encodingStyle=\"http://schemas.xmlsoap.org/soap/encoding/\"><s:Body><u:X_SendKey xmlns:u=\"urn:"+URN+"\"><X_KeyEvent>"+key+"</X_KeyEvent></u:X_SendKey></s:Body></s:Envelope>";
            HttpURLConnection c=(HttpURLConnection)new URL("http://"+host+":"+PORT+"/nrc/control_0").openConnection(); c.setConnectTimeout(2500); c.setReadTimeout(2500); c.setRequestMethod("POST"); c.setDoOutput(true); c.setRequestProperty("Content-Type","text/xml; charset=\"utf-8\""); c.setRequestProperty("SOAPAction","\"urn:"+URN+"#X_SendKey\""); byte[] bytes=body.getBytes(StandardCharsets.UTF_8); c.setFixedLengthStreamingMode(bytes.length); try(OutputStream out=c.getOutputStream()){ out.write(bytes); } int code=c.getResponseCode(); c.disconnect(); runOnUiThread(()->status.setText(code>=200&&code<300?"Command sent ✓":"TV replied HTTP "+code+". This model may need pairing or Network Remote enabled."));
        } catch(Exception e){ runOnUiThread(()->status.setText("Could not reach TV. Check same Wi-Fi / IP / TV network-remote setting.")); }
    }); }
    @Override protected void onDestroy(){ super.onDestroy(); io.shutdownNow(); }
}
