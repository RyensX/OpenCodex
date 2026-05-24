package dev.opencodex.android;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Context;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.ConnectivityManager;
import android.net.Network;
import android.os.Build;
import android.os.Bundle;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.Window;
import android.view.inputmethod.InputMethodManager;
import android.view.inputmethod.EditorInfo;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

public class MainActivity extends Activity {
    private static final String PREFS = "opencodex";
    private static final String KEY_URL = "gateway_url";

    private EditText urlInput;
    private TextView statusText;
    private WebView webView;
    private ScrollView setupView;
    private Button settingsButton;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        configureSystemBars();
        buildLayout();
        configureWebView();
        watchNetworkChanges();

        String savedUrl = prefs().getString(KEY_URL, "");
        if (!savedUrl.isEmpty()) {
            urlInput.setText(savedUrl);
            loadGateway(savedUrl);
        } else {
            showSetup("输入电脑端局域网地址后连接。");
        }
    }

    private SharedPreferences prefs() {
        return getSharedPreferences(PREFS, MODE_PRIVATE);
    }

    private void configureSystemBars() {
        Window window = getWindow();
        window.setStatusBarColor(Color.WHITE);
        window.setNavigationBarColor(Color.WHITE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            window.getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR);
        }
    }

    private void buildLayout() {
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.WHITE);

        webView = new WebView(this);
        webView.setVisibility(View.GONE);
        root.addView(webView, new FrameLayout.LayoutParams(-1, -1));

        setupView = new ScrollView(this);
        setupView.setFillViewport(true);
        setupView.setBackgroundColor(Color.WHITE);

        LinearLayout panel = new LinearLayout(this);
        panel.setOrientation(LinearLayout.VERTICAL);
        panel.setGravity(Gravity.CENTER_HORIZONTAL);
        panel.setPadding(dp(22), dp(48), dp(22), dp(24));
        setupView.addView(panel, new ScrollView.LayoutParams(-1, -1));

        TextView title = new TextView(this);
        title.setText("OpenCodex");
        title.setTextColor(Color.rgb(17, 24, 39));
        title.setTextSize(32);
        title.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        panel.addView(title, new LinearLayout.LayoutParams(-1, -2));

        TextView subtitle = new TextView(this);
        subtitle.setText("连接电脑端服务，在手机上继续当前会话");
        subtitle.setTextColor(Color.rgb(82, 91, 107));
        subtitle.setTextSize(16);
        subtitle.setPadding(0, dp(8), 0, dp(24));
        subtitle.setLineSpacing(0, 1.18f);
        panel.addView(subtitle, new LinearLayout.LayoutParams(-1, -2));

        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setPadding(dp(16), dp(18), dp(16), dp(16));
        card.setBackground(rounded(Color.rgb(247, 249, 252), dp(18), Color.rgb(224, 229, 238), 1));
        panel.addView(card, new LinearLayout.LayoutParams(-1, -2));

        TextView label = new TextView(this);
        label.setText("访问地址");
        label.setTextColor(Color.rgb(40, 45, 53));
        label.setTextSize(14);
        label.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        card.addView(label, new LinearLayout.LayoutParams(-1, -2));

        urlInput = new EditText(this);
        urlInput.setSingleLine(true);
        urlInput.setHint("例如 192.168.123.104:20095");
        urlInput.setTextSize(16);
        urlInput.setTextColor(Color.rgb(17, 24, 39));
        urlInput.setHintTextColor(Color.rgb(145, 153, 166));
        urlInput.setSelectAllOnFocus(true);
        urlInput.setInputType(EditorInfo.TYPE_TEXT_VARIATION_URI);
        urlInput.setImeOptions(EditorInfo.IME_ACTION_GO);
        urlInput.setPadding(dp(12), 0, dp(12), 0);
        urlInput.setBackground(rounded(Color.WHITE, dp(12), Color.rgb(213, 218, 226), 1));
        LinearLayout.LayoutParams inputParams = new LinearLayout.LayoutParams(-1, dp(52));
        inputParams.setMargins(0, dp(10), 0, dp(12));
        card.addView(urlInput, inputParams);

        Button connect = new Button(this);
        connect.setText("连接");
        connect.setTextColor(Color.WHITE);
        connect.setTextSize(16);
        connect.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        connect.setAllCaps(false);
        connect.setBackground(rounded(Color.rgb(16, 139, 105), dp(14), Color.TRANSPARENT, 0));
        card.addView(connect, new LinearLayout.LayoutParams(-1, dp(52)));

        statusText = new TextView(this);
        statusText.setTextColor(Color.rgb(112, 119, 130));
        statusText.setTextSize(13);
        statusText.setLineSpacing(0, 1.15f);
        LinearLayout.LayoutParams statusParams = new LinearLayout.LayoutParams(-1, -2);
        statusParams.setMargins(0, dp(14), 0, 0);
        card.addView(statusText, statusParams);

        TextView hint = new TextView(this);
        hint.setText("电脑端需打开“局域网”访问；连接成功后只保留沉浸式手机界面。");
        hint.setTextColor(Color.rgb(132, 139, 150));
        hint.setTextSize(13);
        hint.setLineSpacing(0, 1.2f);
        LinearLayout.LayoutParams hintParams = new LinearLayout.LayoutParams(-1, -2);
        hintParams.setMargins(0, dp(22), 0, 0);
        panel.addView(hint, hintParams);

        root.addView(setupView, new FrameLayout.LayoutParams(-1, -1));

        settingsButton = new Button(this);
        settingsButton.setText("地址");
        settingsButton.setTextSize(13);
        settingsButton.setAllCaps(false);
        settingsButton.setTextColor(Color.rgb(40, 45, 53));
        settingsButton.setBackground(rounded(Color.argb(235, 255, 255, 255), dp(18), Color.rgb(225, 229, 235), 1));
        settingsButton.setVisibility(View.GONE);
        FrameLayout.LayoutParams settingsParams = new FrameLayout.LayoutParams(dp(64), dp(38), Gravity.TOP | Gravity.CENTER_HORIZONTAL);
        settingsParams.setMargins(0, dp(12), 0, 0);
        root.addView(settingsButton, settingsParams);
        settingsButton.setTranslationX(-dp(76));

        setContentView(root);

        connect.setOnClickListener(v -> connectFromInput());
        settingsButton.setOnClickListener(v -> showSetup("修改地址后重新连接。"));
        urlInput.setOnEditorActionListener((TextView v, int actionId, KeyEvent event) -> {
            if (actionId == EditorInfo.IME_ACTION_GO) {
                connectFromInput();
                return true;
            }
            return false;
        });
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void configureWebView() {
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setLoadWithOverviewMode(false);
        settings.setUseWideViewPort(true);
        settings.setTextZoom(100);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        settings.setUserAgentString(settings.getUserAgentString() + " OpenCodexAndroid/1.0");

        webView.setBackgroundColor(Color.WHITE);
        webView.setOverScrollMode(View.OVER_SCROLL_NEVER);
        webView.setVerticalScrollBarEnabled(false);
        webView.setHorizontalScrollBarEnabled(false);
        WebView.setWebContentsDebuggingEnabled(false);
        webView.setWebChromeClient(new WebChromeClient());
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return false;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                setupView.setVisibility(View.GONE);
                webView.setVisibility(View.VISIBLE);
                settingsButton.setVisibility(View.VISIBLE);
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request != null && request.isForMainFrame()) {
                    showSetup("连接失败，请确认电脑和手机在同一网络，且电脑端已切到局域网模式。");
                }
            }
        });
    }

    private void connectFromInput() {
        String value = normalizeUrl(urlInput.getText().toString());
        if (value.isEmpty()) return;
        urlInput.setText(value);
        hideKeyboard();
        prefs().edit().putString(KEY_URL, value).apply();
        loadGateway(value);
    }

    private void loadGateway(String url) {
        statusText.setText("正在连接 " + url);
        webView.setVisibility(View.VISIBLE);
        webView.loadUrl(url);
    }

    private void showSetup(String message) {
        webView.setVisibility(View.GONE);
        statusText.setText(message);
        setupView.setVisibility(View.VISIBLE);
        settingsButton.setVisibility(View.GONE);
    }

    private void hideKeyboard() {
        urlInput.clearFocus();
        InputMethodManager manager = (InputMethodManager) getSystemService(Context.INPUT_METHOD_SERVICE);
        if (manager != null) {
            manager.hideSoftInputFromWindow(urlInput.getWindowToken(), 0);
        }
    }

    private String normalizeUrl(String raw) {
        String value = raw == null ? "" : raw.trim();
        if (value.isEmpty()) return "";
        if (!value.startsWith("http://") && !value.startsWith("https://")) {
            value = "http://" + value;
        }
        return value;
    }

    private void watchNetworkChanges() {
        ConnectivityManager manager = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
        if (manager == null) return;
        manager.registerDefaultNetworkCallback(new ConnectivityManager.NetworkCallback() {
            @Override
            public void onAvailable(Network network) {
                runOnUiThread(() -> {
                    String url = prefs().getString(KEY_URL, "");
                    if (!url.isEmpty() && webView.getUrl() == null) loadGateway(url);
                });
            }
        });
    }

    @Override
    public void onBackPressed() {
        if (setupView.getVisibility() != View.VISIBLE && webView.canGoBack()) {
            webView.goBack();
        } else if (setupView.getVisibility() != View.VISIBLE) {
            showSetup("修改地址后重新连接。");
        } else {
            super.onBackPressed();
        }
    }

    private GradientDrawable rounded(int color, int radius, int strokeColor, int strokeWidth) {
        GradientDrawable drawable = new GradientDrawable();
        drawable.setColor(color);
        drawable.setCornerRadius(radius);
        if (strokeWidth > 0) drawable.setStroke(strokeWidth, strokeColor);
        return drawable;
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }
}
