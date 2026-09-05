import QtQuick
import QtQuick.Controls
import QtQuick.Effects
import Quickshell
import Quickshell.Services.SystemTray
import qs.Commons
import qs.Ui

// Envy's eye in the bar — the Mac menu bar item as an Omarchy bar widget.
//
// Envy is the source of truth: it registers a StatusNotifierItem whose icon
// name carries the lid position and whose menu is the app's own. This widget
// draws that item as a first-class bar icon (the tray keeps it hidden) and
// launches Envy when it isn't running.
BarWidget {
  id: root
  moduleName: "skuthus.envy"

  readonly property color foreground: bar ? bar.foreground : Color.foreground
  readonly property string fontFamily: bar ? bar.fontFamily : Style.font.family

  readonly property var item: {
    var values = SystemTray.items.values
    for (var i = 0; i < values.length; i++) {
      if (String(values[i].id || "") === "envy") return values[i]
    }
    return null
  }
  readonly property bool running: item !== null
  // The widget's own entry in shell.json: `"showWhenClosed": true` keeps a
  // dim eye in the bar as a launcher while Envy isn't running. Off — the
  // default — the eye is only there while Envy is, like a running-app
  // indicator; Ctrl+Alt+Return or the app launcher starts it. Envy's own
  // menu toggles this, and writes it here.
  readonly property bool showWhenClosed: !!(root.settings && root.settings.showWhenClosed === true)
  readonly property string eye: {
    var icon = item ? String(item.icon || "") : ""
    if (icon.indexOf("envy-open") !== -1) return "open"
    if (icon.indexOf("envy-squint") !== -1) return "squint"
    return "closed"
  }
  // Written by Envy when it installs the plugin: the binary to start.
  readonly property string launcher: String(Qt.resolvedUrl("launch.sh")).replace(/^file:\/\//, "")

  property bool menuOpen: false

  visible: running || showWhenClosed
  implicitWidth: visible ? button.implicitWidth : 0
  implicitHeight: button.implicitHeight

  function summon() {
    if (item) item.activate()
    else if (bar) bar.run("sh " + bar.shellQuote(launcher))
  }

  function close() {
    menuOpen = false
  }

  BarIconButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    iconComponent: Component {
      Item {
        Item {
          id: eyeBox
          anchors.centerIn: parent
          width: Style.space(15)
          height: Style.space(15)
          opacity: root.running ? 1.0 : 0.55

          Image {
            id: eyeImage
            anchors.fill: parent
            source: Qt.resolvedUrl("eye-" + root.eye + ".svg")
            sourceSize.width: Math.round(eyeBox.width * Screen.devicePixelRatio)
            sourceSize.height: Math.round(eyeBox.height * Screen.devicePixelRatio)
            fillMode: Image.PreserveAspectFit
            visible: false
            layer.enabled: true
          }

          MultiEffect {
            anchors.fill: eyeImage
            source: eyeImage
            colorization: 1.0
            colorizationColor: root.foreground
          }
        }
      }
    }
    tooltipText: root.running ? "Envy" : "Envy (not running)"
    onPressed: function(buttonCode) {
      if (buttonCode === Qt.RightButton) {
        if (root.item && root.item.menu) {
          root.resetMenu()
          root.menuOpen = true
        }
      } else {
        root.summon()
      }
    }
  }

  // --- Menu -----------------------------------------------------------------
  // Envy's menu arrives as a dbusmenu. The tray widget's renderer is the
  // reference for this: QsMenuOpener per level, a submenu stack for "New
  // Pinned Note from Template", and rows that trigger the entry.

  property var submenuStack: []
  readonly property int submenuDepth: submenuStack.length
  readonly property string currentTitle: submenuDepth > 0 ? submenuStack[submenuDepth - 1].title : ""
  readonly property var currentChildren: submenuDepth > 0
    ? submenuStack[submenuDepth - 1].opener.children
    : menuOpener.children

  Component {
    id: submenuOpenerComponent
    QsMenuOpener {}
  }

  function resetMenu() {
    menuFlick.contentY = 0
    var openers = submenuStack
    submenuStack = []
    for (var i = openers.length - 1; i >= 0; i--) openers[i].opener.destroy()
  }

  function enterSubmenu(entry, title) {
    var opener = submenuOpenerComponent.createObject(root, { menu: entry })
    if (!opener) return
    var stack = submenuStack.slice()
    stack.push({ opener: opener, title: title })
    submenuStack = stack
  }

  function leaveSubmenu() {
    if (submenuStack.length === 0) return
    var stack = submenuStack.slice()
    var top = stack.pop()
    submenuStack = stack
    top.opener.destroy()
  }

  QsMenuOpener {
    id: menuOpener
    menu: root.item ? root.item.menu : null
  }

  PopupCard {
    id: menuPopup
    anchorItem: root
    owner: root
    bar: root.bar
    open: root.menuOpen
    onVisibleChanged: if (!visible) root.resetMenu()
    padding: Style.space(8)
    borderColor: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.45)
    contentWidth: menuPopup.fittedContentWidth(Style.space(232))
    contentHeight: menuPopup.fittedContentHeight(menuHeaderHeight + menuColumn.implicitHeight, Style.space(420))

    readonly property int menuHeaderHeight: menuHeader.visible ? menuHeader.implicitHeight : 0

    Column {
      id: menuLayout
      anchors.fill: parent
      spacing: 0

      Column {
        id: menuHeader
        visible: root.submenuDepth > 0
        width: menuLayout.width
        spacing: 0

        Item {
          width: menuHeader.width
          implicitHeight: Style.space(30)

          Rectangle {
            anchors.fill: parent
            radius: Math.max(2, Style.cornerRadius)
            color: backMouse.containsMouse ? Style.hoverFillFor(root.foreground, root.foreground) : "transparent"
          }

          Text {
            anchors.verticalCenter: parent.verticalCenter
            anchors.left: parent.left
            width: Style.space(22)
            horizontalAlignment: Text.AlignHCenter
            text: "‹"
            color: root.foreground
            font.family: root.fontFamily
            font.pixelSize: Style.font.bodySmall
          }

          Text {
            textFormat: Text.PlainText
            anchors.verticalCenter: parent.verticalCenter
            anchors.left: parent.left
            anchors.leftMargin: Style.space(28)
            anchors.right: parent.right
            anchors.rightMargin: Style.space(10)
            text: root.currentTitle
            color: root.foreground
            font.family: root.fontFamily
            font.pixelSize: Style.font.bodySmall
            elide: Text.ElideRight
          }

          MouseArea {
            id: backMouse
            anchors.fill: parent
            hoverEnabled: true
            cursorShape: Qt.PointingHandCursor
            onClicked: {
              menuFlick.contentY = 0
              root.leaveSubmenu()
            }
          }
        }

        Item {
          width: menuHeader.width
          implicitHeight: Style.space(11)

          Rectangle {
            anchors.left: parent.left
            anchors.leftMargin: Style.space(10)
            anchors.right: parent.right
            anchors.rightMargin: Style.space(10)
            anchors.verticalCenter: parent.verticalCenter
            height: 1
            color: Color.popups.border
            opacity: 0.45
          }
        }
      }

      Flickable {
        id: menuFlick
        width: menuLayout.width
        height: menuLayout.height - menuPopup.menuHeaderHeight
        contentWidth: width
        contentHeight: menuColumn.implicitHeight
        clip: true
        boundsBehavior: Flickable.StopAtBounds
        flickableDirection: Flickable.VerticalFlick
        interactive: contentHeight > height

        ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }

        Column {
          id: menuColumn
          width: menuFlick.width
          spacing: 0

          Repeater {
            model: root.currentChildren

            delegate: Item {
              id: menuRow
              required property var modelData
              required property int index

              readonly property string rowText: String(modelData.text || "")

              width: menuColumn.width
              implicitHeight: modelData.isSeparator ? Style.space(11) : Style.space(30)
              opacity: modelData.enabled ? 1.0 : 0.45

              Rectangle {
                visible: menuRow.modelData.isSeparator
                anchors.left: parent.left
                anchors.leftMargin: Style.space(10)
                anchors.right: parent.right
                anchors.rightMargin: Style.space(10)
                anchors.verticalCenter: parent.verticalCenter
                height: 1
                color: Color.popups.border
                opacity: 0.45
              }

              Rectangle {
                visible: !menuRow.modelData.isSeparator
                anchors.fill: parent
                radius: Math.max(2, Style.cornerRadius)
                color: rowMouse.containsMouse && menuRow.modelData.enabled ? Style.hoverFillFor(root.foreground, root.foreground) : "transparent"
              }

              Text {
                textFormat: Text.PlainText
                visible: !menuRow.modelData.isSeparator && menuRow.modelData.buttonType !== QsMenuButtonType.None
                anchors.verticalCenter: parent.verticalCenter
                anchors.left: parent.left
                width: Style.space(22)
                horizontalAlignment: Text.AlignHCenter
                text: menuRow.modelData.checkState === Qt.Checked ? "" : ""
                color: root.foreground
                font.family: root.fontFamily
                font.pixelSize: Style.font.bodySmall
              }

              Text {
                textFormat: Text.PlainText
                visible: !menuRow.modelData.isSeparator
                anchors.verticalCenter: parent.verticalCenter
                anchors.left: parent.left
                anchors.leftMargin: Style.space(28)
                anchors.right: submenuGlyph.left
                anchors.rightMargin: Style.space(8)
                text: menuRow.rowText
                color: root.foreground
                font.family: root.fontFamily
                font.pixelSize: Style.font.bodySmall
                elide: Text.ElideRight
              }

              Text {
                id: submenuGlyph
                visible: !menuRow.modelData.isSeparator && menuRow.modelData.hasChildren
                anchors.verticalCenter: parent.verticalCenter
                anchors.right: parent.right
                anchors.rightMargin: Style.space(10)
                text: "›"
                color: root.foreground
                font.family: root.fontFamily
                font.pixelSize: Style.font.bodySmall
              }

              MouseArea {
                id: rowMouse
                anchors.fill: parent
                hoverEnabled: true
                enabled: !menuRow.modelData.isSeparator && menuRow.modelData.enabled
                cursorShape: enabled ? Qt.PointingHandCursor : Qt.ArrowCursor
                onClicked: {
                  if (menuRow.modelData.hasChildren) {
                    menuFlick.contentY = 0
                    root.enterSubmenu(menuRow.modelData, menuRow.rowText)
                  } else {
                    menuRow.modelData.triggered()
                    root.close()
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}
